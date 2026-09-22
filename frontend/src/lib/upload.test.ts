import { beforeEach, describe, expect, it, vi } from "vitest";

import { postToStorage } from "./upload";

// ── The browser half of a provider-neutral upload ─────────────────────────────────────────────
//
// This client is handed an envelope — a method, a URL and a bag of fields — and performs it. It does
// not know, and must never learn, which storage backend is on the other end: a client that could
// tell would eventually grow an `if (provider === ...)`, and then every new provider means a
// frontend change.
//
// What it MUST get right is the multipart protocol, because two providers disagree about it in ways
// that are silent when wrong:
//
//   • the fields are what a signature was computed over, so any edit invalidates the upload;
//   • an S3 POST policy requires the file to be the LAST part (Cloudinary does not care);
//   • an S3 presigned POST answers 204 with no body, while Cloudinary answers JSON.

interface FakeXhr {
  status: number;
  responseText: string;
  open: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  upload: { onprogress: ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

let xhr: FakeXhr;
let sent: FormData | null;

/** Install a fake XHR that completes with the given status/body as soon as `send` is called. */
function respondWith(status: number, responseText = "") {
  sent = null;
  xhr = {
    status,
    responseText,
    open: vi.fn(),
    abort: vi.fn(),
    upload: { onprogress: null },
    onload: null,
    onerror: null,
    onabort: null,
    send: vi.fn((form: FormData) => {
      sent = form;
      // Synchronous completion keeps these tests free of timers; the promise resolves on the
      // microtask queue either way.
      queueMicrotask(() => xhr.onload?.());
    }),
  };
  // A real `function`, not an arrow: vitest needs a constructible stand-in for `new XMLHttpRequest()`.
  vi.stubGlobal(
    "XMLHttpRequest",
    function XMLHttpRequestStub() {
      return xhr;
    } as unknown as typeof XMLHttpRequest,
  );
}

const ENVELOPE = {
  method: "POST" as const,
  url: "https://storage.example/upload",
  fields: {
    // Deliberately NOT all-Cloudinary and NOT all-S3: this client treats them as opaque, so the
    // test uses a mixture to prove nothing here is being interpreted.
    policy: "eyJleHBpcmF0aW9uIjoi",
    "x-amz-signature": "abc123",
    api_key: "k",
    timestamp: "1700000000",
    overwrite: "false",
  },
  publicId: "senthra/jobs/uuid/Report.pdf",
  purpose: "job_attachment" as const,
};

const FILE = new File(["hello"], "Report.pdf", { type: "application/pdf" });

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("postToStorage — it performs the envelope, whatever it says", () => {
  it("posts to the URL and with the method the envelope names", async () => {
    respondWith(200, "{}");
    await postToStorage(ENVELOPE, FILE);
    expect(xhr.open).toHaveBeenCalledWith("POST", "https://storage.example/upload");
  });

  // The fields ARE the signature's payload. Renaming, reordering, re-stringifying or dropping one
  // invalidates the upload — so this side forwards them untouched.
  it("submits every field verbatim, and adds nothing of its own", async () => {
    respondWith(200, "{}");
    await postToStorage(ENVELOPE, FILE);

    const entries = [...sent!.entries()];
    const fields = entries.filter(([name]) => name !== "file");
    expect(fields).toEqual(Object.entries(ENVELOPE.fields));
  });

  it("preserves the field ORDER the server sent", async () => {
    respondWith(200, "{}");
    await postToStorage(ENVELOPE, FILE);

    const names = [...sent!.keys()].filter((n) => n !== "file");
    expect(names).toEqual(Object.keys(ENVELOPE.fields));
  });

  // An S3 POST policy requires it. Cloudinary does not care, so last is correct for both — and this
  // used to append the file FIRST, which would have failed every Spaces upload.
  it("appends the file LAST, after every field", async () => {
    respondWith(200, "{}");
    await postToStorage(ENVELOPE, FILE);

    const names = [...sent!.keys()];
    expect(names[names.length - 1]).toBe("file");
    expect(names.filter((n) => n === "file")).toHaveLength(1);
  });
});

describe("postToStorage — success is the status, not the body", () => {
  // The S3 presigned-POST shape: no body at all.
  it("accepts a 204 with an empty body", async () => {
    respondWith(204, "");
    await expect(postToStorage(ENVELOPE, FILE)).resolves.toEqual({});
  });

  it("accepts a 200 whose body is not JSON", async () => {
    respondWith(200, "<PostResponse><Key>senthra/jobs/x</Key></PostResponse>");
    await expect(postToStorage(ENVELOPE, FILE)).resolves.toEqual({});
  });

  it("accepts a 201 with whitespace for a body", async () => {
    respondWith(201, "   \n ");
    await expect(postToStorage(ENVELOPE, FILE)).resolves.toEqual({});
  });

  // The Cloudinary shape: a signed JSON receipt, which finalize checks. It is read when present and
  // never required.
  it("passes a JSON receipt through when the provider sends one", async () => {
    respondWith(200, JSON.stringify({ public_id: "senthra/jobs/real-id", version: 17, signature: "sig" }));
    await expect(postToStorage(ENVELOPE, FILE)).resolves.toEqual({
      publicId: "senthra/jobs/real-id",
      version: 17,
      signature: "sig",
    });
  });
});

describe("postToStorage — failure", () => {
  it("rejects a non-2xx status", async () => {
    respondWith(400, "");
    await expect(postToStorage(ENVELOPE, FILE)).rejects.toThrow(/upload failed \(400\)/i);
  });

  it("surfaces the provider's own reason when it gives one", async () => {
    respondWith(400, JSON.stringify({ error: { message: "Invalid extension in upload_preset allowlist" } }));
    await expect(postToStorage(ENVELOPE, FILE)).rejects.toThrow(/invalid extension/i);
  });

  // A failure body in an unknown shape must not itself become a failure to report the failure.
  it("falls back to the status when the error body is not JSON", async () => {
    respondWith(403, "<Error><Code>AccessDenied</Code></Error>");
    await expect(postToStorage(ENVELOPE, FILE)).rejects.toThrow(/upload failed \(403\)/i);
  });

  it("rejects a 500 rather than treating it as a bodyless success", async () => {
    respondWith(500, "");
    await expect(postToStorage(ENVELOPE, FILE)).rejects.toThrow(/upload failed \(500\)/i);
  });
});

describe("postToStorage — it cannot tell which provider it is talking to", () => {
  // The property this whole change exists to create. The client reads `method`, `url` and `fields`
  // and nothing else; there is no provider name in the envelope to branch on even if it wanted to.
  it("behaves identically for two completely different field shapes", async () => {
    respondWith(204, "");
    await postToStorage({ ...ENVELOPE, fields: { policy: "p", "x-amz-credential": "c", key: "k" } }, FILE);
    const spaces = [...sent!.keys()];

    respondWith(204, "");
    await postToStorage({ ...ENVELOPE, fields: { api_key: "k", signature: "s", public_id: "p" } }, FILE);
    const cloudinary = [...sent!.keys()];

    // Different field names, same protocol: every field forwarded, file last, 204 accepted.
    expect(spaces).toEqual(["policy", "x-amz-credential", "key", "file"]);
    expect(cloudinary).toEqual(["api_key", "signature", "public_id", "file"]);
  });
});
