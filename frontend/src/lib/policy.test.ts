import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The public policy fetch. Its one job beyond fetching is to fail CLOSED: every path that is not a
 * successful published policy must return null, because the page renders an "unavailable" state for
 * null and there is nothing else it could safely show. A fallback here would be the one place a
 * non-approved document could reach a public reader.
 *
 * `React.cache` memoises within a render pass, so each case re-imports the module for a clean one.
 */

async function fetchPolicy() {
  vi.resetModules();
  const { fetchPublishedPolicy } = await import("./policy");
  return fetchPublishedPolicy();
}

const PUBLISHED = {
  version: 3,
  publishedAt: "2026-08-21T00:00:00.000Z",
  blocks: [{ type: "heading", text: "Who we are" }],
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPublishedPolicy", () => {
  it("returns the published policy when the API has one", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ policy: PUBLISHED }) });
    expect(await fetchPolicy()).toEqual(PUBLISHED);
  });

  it("returns null when nothing is published", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ policy: null }) });
    expect(await fetchPolicy()).toBeNull();
  });

  it("returns null when the response omits the key entirely", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    expect(await fetchPolicy()).toBeNull();
  });

  it("returns null on a non-OK response rather than guessing", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ policy: PUBLISHED }) });
    expect(await fetchPolicy()).toBeNull();
  });

  it("returns null when the backend is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await fetchPolicy()).toBeNull();
  });

  it("asks the PUBLIC endpoint, uncached", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ policy: PUBLISHED }) });
    await fetchPolicy();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/policies/privacy");
    // Not the admin route — that one would carry draft content and require a session.
    expect(String(url)).not.toContain("/admin");
    expect(opts).toMatchObject({ cache: "no-store" });
  });
});
