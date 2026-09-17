import { describe, expect, it, vi } from "vitest";

import { errorHandler } from "./error.middleware.js";
import { HttpError } from "../utils/http-error.js";

// The 5xx masking rule and its one deliberate exception.
//
// Masking exists so an uncaught exception never leaks a stack, a driver message or a connection
// string to the browser. An HttpError is different in kind: its message is a sentence WE wrote for
// the user. Masking those too turned "Couldn't send your verification code" into "Internal Server
// Error", which reads as "the app is broken" rather than "try again".

function run(err: unknown): { status: number; body: { error: string } } {
  let status = 0;
  let body = { error: "" };
  const res = {
    status(c: number) {
      status = c;
      return res;
    },
    json(b: { error: string }) {
      body = b;
      return res;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  errorHandler(err, {} as any, res as any, vi.fn());
  return { status, body };
}

describe("errorHandler", () => {
  it("masks a raw exception at 500 — no internals reach the client", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("connect ECONNREFUSED 10.0.0.5:27017 at Connection.onError");
    const { status, body } = run(err);

    expect(status).toBe(500);
    expect(body.error).toBe("Internal Server Error");
    expect(body.error).not.toContain("ECONNREFUSED");
    // Still logged server-side for diagnosis.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("surfaces a CURATED 5xx message, because we wrote it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = run(
      new HttpError(502, "Couldn't send your verification code. Please try again."),
    );

    expect(status).toBe(502);
    expect(body.error).toBe("Couldn't send your verification code. Please try again.");
    spy.mockRestore();
  });

  it("still surfaces ordinary 4xx HttpError messages unchanged", () => {
    expect(run(new HttpError(401, "That code is incorrect or has expired."))).toEqual({
      status: 401,
      body: { error: "That code is incorrect or has expired." },
    });
    expect(run(new HttpError(409, "Already exists."))).toEqual({
      status: 409,
      body: { error: "Already exists." },
    });
  });

  it("defaults an error with no status to 500 and masks it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(run({ nope: true }).body.error).toBe("Internal Server Error");
    spy.mockRestore();
  });
});
