import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── The connection probe ──────────────────────────────────────────────────────────────────────
//
// This is what the switch guard trusts. An administrator cannot make Spaces the active provider
// until this returns ok, so everything it FAILS to check is something that passes review and then
// breaks in production.
//
// It had no tests at all: spaces.test.ts never reached it and settings.storage.test.ts mocks it
// away wholesale. So the one function standing between a typo and a broken install was the one
// function nobody exercised.
//
// What it must prove, beyond "the credentials work":
//
//   • the bucket ACCEPTS a public-read ACL — every upload sets one, and a bucket that refuses it
//     refuses all of them;
//   • the object is then readable ANONYMOUSLY at the address we hand out, because every stored row
//     holds a plain URL and no authenticated fetch is ever made;
//   • that address is built from `cdnUrl` when set — a value none of the S3 calls touch, so a
//     mistyped CDN origin used to pass green and then get written permanently into attachment rows;
//   • and it cleans up after itself on EVERY path, including the failures.
const { send, presign } = vi.hoisted(() => ({ send: vi.fn(), presign: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      send = send;
      // Mirrors the real client: the adapter destroys a superseded one when the configuration
      // changes, so a mock without this would throw on the swap rather than on anything real.
      destroy = vi.fn();
    },
    PutObjectCommand: class extends Cmd {
      readonly name = "PutObject";
    },
    HeadBucketCommand: class extends Cmd {
      readonly name = "HeadBucket";
    },
    HeadObjectCommand: class extends Cmd {
      readonly name = "HeadObject";
    },
    GetObjectCommand: class extends Cmd {
      readonly name = "GetObject";
    },
    DeleteObjectCommand: class extends Cmd {
      readonly name = "DeleteObject";
    },
  };
});
vi.mock("@aws-sdk/s3-presigned-post", () => ({ createPresignedPost: presign }));

import { probeSpacesConnection, __resetSpacesClient, type SpacesConfig } from "./spaces.js";

const SECRET = "super-secret-do-not-leak";
const CONFIG: SpacesConfig = {
  endpoint: "https://ams3.digitaloceanspaces.com",
  region: "ams3",
  bucket: "senthra-prod",
  accessKeyId: "DO00EXAMPLE",
  secretAccessKey: SECRET,
  cdnUrl: null,
};

/** Every command the probe issued, in order. */
const sent = () => send.mock.calls.map((c) => (c[0] as { name: string; input: Record<string, unknown> }));
const named = (name: string) => sent().filter((c) => c.name === name);

/** The token the probe wrote — what the delivery fetch has to echo back to count as success. */
const writtenToken = (): string => String((named("PutObject")[0]!.input as { Body: Buffer }).Body);

/** A fetch stub that answers with whatever the probe just uploaded. */
const servesTheUpload = () =>
  vi.fn(async () => new Response(writtenToken(), { status: 200 }));

const fetchUrls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  send.mockReset().mockResolvedValue({});
  __resetSpacesClient();
});
afterEach(() => vi.unstubAllGlobals());

describe("what a green tick now means", () => {
  it("passes only after fetching the object back from the address it hands out", async () => {
    const fetchMock = servesTheUpload();
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeSpacesConnection(CONFIG);

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/serves public files/i);
    expect(fetchUrls(fetchMock)[0]).toMatch(/^https:\/\/senthra-prod\.ams3\.digitaloceanspaces\.com\/_healthcheck\//);
  });

  // The gap this closes. The S3 calls all go to the ENDPOINT; only delivery uses the CDN, so a
  // mistyped CDN origin was invisible to the old probe — and then became part of every stored URL.
  it("fetches through the CDN when one is configured", async () => {
    const fetchMock = servesTheUpload();
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeSpacesConnection({ ...CONFIG, cdnUrl: "https://files.example.com" });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/through the CDN/i);
    expect(fetchUrls(fetchMock)[0]).toMatch(/^https:\/\/files\.example\.com\/_healthcheck\//);
  });

  // Every real upload sets this ACL. A bucket that refuses it refuses all of them — and the old
  // probe sent no ACL at all, so it never found out.
  it("writes the same public-read ACL a real upload does", async () => {
    vi.stubGlobal("fetch", servesTheUpload());
    await probeSpacesConnection(CONFIG);

    expect(named("PutObject")[0]!.input).toMatchObject({ ACL: "public-read", Bucket: "senthra-prod" });
  });
});

describe("what it now refuses to call a success", () => {
  it("a CDN host that does not resolve", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("getaddrinfo ENOTFOUND"); }));

    const result = await probeSpacesConnection({ ...CONFIG, cdnUrl: "https://typo.example.com" });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/CDN address did not respond/i);
    // Names what to go and look at, rather than the exception.
    expect(result.message).toMatch(/Check the CDN URL/i);
  });

  it("an object that is stored but not publicly readable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));

    const result = await probeSpacesConnection(CONFIG);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not publicly readable/i);
    expect(result.message).toMatch(/403/);
  });

  it("any other unhappy status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));

    const result = await probeSpacesConnection(CONFIG);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/502/);
  });

  // A CDN aimed at the WRONG origin answers 200 all day with somebody else's bytes — which is
  // exactly what a plausible typo produces, and exactly what a status-only check would wave through.
  it("a 200 that serves somebody else's content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("a totally different object", { status: 200 })));

    const result = await probeSpacesConnection({ ...CONFIG, cdnUrl: "https://someone-elses.example.com" });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/different content/i);
    expect(result.message).toMatch(/another origin/i);
  });
});

describe("the S3 failures it always caught", () => {
  it("an unreachable bucket, before writing anything", async () => {
    send.mockRejectedValueOnce(Object.assign(new Error("no"), { name: "NoSuchBucket" }));

    const result = await probeSpacesConnection(CONFIG);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Could not reach the bucket/i);
    expect(named("PutObject")).toHaveLength(0);
  });

  it("credentials that cannot write", async () => {
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error("no"), { name: "AccessDenied" }));

    const result = await probeSpacesConnection(CONFIG);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/cannot write to the bucket/i);
  });

  it("credentials that cannot delete", async () => {
    vi.stubGlobal("fetch", servesTheUpload());
    send.mockImplementation(async (cmd: { name: string }) => {
      if (cmd.name === "DeleteObject") throw Object.assign(new Error("no"), { name: "AccessDenied" });
      return {};
    });

    const result = await probeSpacesConnection(CONFIG);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not be deleted/i);
    expect(result.message).toMatch(/delete permission/i);
  });
});

// A probe that litters is a probe someone runs ten times while debugging, leaving ten objects.
describe("it cleans up after itself", () => {
  it("deletes the test object on success", async () => {
    vi.stubGlobal("fetch", servesTheUpload());
    await probeSpacesConnection(CONFIG);

    expect(named("DeleteObject")).toHaveLength(1);
    expect(named("DeleteObject")[0]!.input.Key).toBe(named("PutObject")[0]!.input.Key);
  });

  it("deletes it even when the delivery check FAILS", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    const result = await probeSpacesConnection(CONFIG);

    expect(result.ok).toBe(false);
    expect(named("DeleteObject")).toHaveLength(1);
  });

  it("deletes it even when the delivery fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    await probeSpacesConnection(CONFIG);

    expect(named("DeleteObject")).toHaveLength(1);
  });
});

describe("the secret", () => {
  it("never appears in any outcome, however the probe fails", async () => {
    const outcomes: string[] = [];

    vi.stubGlobal("fetch", servesTheUpload());
    outcomes.push((await probeSpacesConnection(CONFIG)).message);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    outcomes.push((await probeSpacesConnection(CONFIG)).message);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`signature for ${SECRET} failed`); }));
    outcomes.push((await probeSpacesConnection(CONFIG)).message);

    send.mockRejectedValue(new Error(`bad key ${SECRET}`));
    outcomes.push((await probeSpacesConnection(CONFIG)).message);

    for (const message of outcomes) expect(message).not.toContain(SECRET);
  });
});
