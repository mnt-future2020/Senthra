import { describe, expect, it } from "vitest";

import { UPLOAD_BODY_PATHS } from "../app.js";
import { MAX_JOB_ATTACHMENT_BYTES } from "#modules/job/job.validation.js";
import { GRN_ATTACHMENT_MAX_BYTES } from "#modules/goods-in/goods-in.validation.js";

// The global JSON body ceiling is 5mb, and base64 inflates a file by 4/3 — so the largest FILE that
// fits a default request is ~3.7 MB. Any endpoint that promises more than that needs its path listed
// in UPLOAD_BODY_PATHS, or the parser rejects the upload with a raw "request entity too large"
// before the schema that promised to allow it ever runs.
//
// This is a list a developer has to remember to extend, and on first writing it was short by two:
// purchase-order and goods-in attachments both advertised limits they could not accept. That is the
// failure this file exists to catch — the same class as an orphan sweep that has to be told about
// every new consumer.

const GLOBAL_LIMIT_BYTES = 5 * 1024 * 1024;
/** Largest raw file that survives base64 expansion inside a given body ceiling. */
const fileCeiling = (bodyBytes: number) => Math.floor(bodyBytes * 0.75);

// Every route whose schema accepts a `data:` URI, with the file size it advertises to the user.
// `advertised` is the raw file limit the schema enforces — NOT the encoded body length.
const UPLOAD_ROUTES = [
  { path: "/jobs/attachment", advertised: MAX_JOB_ATTACHMENT_BYTES },
  { path: "/purchase-requests/64b7f9c2e1a4d5f6a7b8c9d0/attachments", advertised: 10 * 1024 * 1024 },
  { path: "/purchase-orders/64b7f9c2e1a4d5f6a7b8c9d0/attachments", advertised: 10 * 1024 * 1024 },
  { path: "/goods-in/64b7f9c2e1a4d5f6a7b8c9d0/attachments", advertised: GRN_ATTACHMENT_MAX_BYTES },
];

// These cap the DATA URI itself (already base64) at 3 MB, so the encoded body is 3 MB and fits the
// global ceiling. Listed so the distinction is recorded rather than rediscovered.
const IMAGE_ROUTES_UNDER_GLOBAL_LIMIT = [
  "/settings/branding/logo",
  "/users/me/avatar",
  "/users/me/signature",
  "/job-kit-requests/attachments",
  "/van-stock-requests/attachments",
  "/engineer-transfers/attachments",
];

describe("upload body limits", () => {
  it.each(UPLOAD_ROUTES)("$path advertises more than the global ceiling, so it is widened", ({ path, advertised }) => {
    // Guards the premise: if a limit is lowered under ~3.7 MB this route no longer needs widening,
    // and this expectation is the prompt to reconsider rather than a silent pass.
    expect(advertised, "advertised limit no longer exceeds the global ceiling").toBeGreaterThan(
      fileCeiling(GLOBAL_LIMIT_BYTES),
    );
    expect(UPLOAD_BODY_PATHS.test(path), `${path} is missing from UPLOAD_BODY_PATHS`).toBe(true);
  });

  it("widens with enough headroom for the largest advertised file once base64-encoded", () => {
    const widened = 15 * 1024 * 1024;
    const largest = Math.max(...UPLOAD_ROUTES.map((r) => r.advertised));
    expect(fileCeiling(widened)).toBeGreaterThanOrEqual(largest);
  });

  it.each(IMAGE_ROUTES_UNDER_GLOBAL_LIMIT)("%s stays on the global parser", (path) => {
    expect(UPLOAD_BODY_PATHS.test(path)).toBe(false);
  });

  // The widened ceiling must not leak onto unauthenticated or unrelated routes — the global limit is
  // also the limit on /auth/login, and a 15 MB body there is free work for an attacker.
  it.each([
    "/auth/login",
    "/jobs",
    "/jobs/64b7f9c2e1a4d5f6a7b8c9d0",
    "/purchase-orders",
    "/purchase-orders/64b7f9c2e1a4d5f6a7b8c9d0",
    "/goods-in/64b7f9c2e1a4d5f6a7b8c9d0",
    "/customers",
  ])("%s keeps the 5mb ceiling", (path) => {
    expect(UPLOAD_BODY_PATHS.test(path)).toBe(false);
  });

  // Deleting an attachment carries no body at all; only the POST needs widening.
  it("does not widen an attachment DELETE sub-path", () => {
    expect(UPLOAD_BODY_PATHS.test("/purchase-orders/64b7f9c2e1a4d5f6a7b8c9d0/attachments/att1")).toBe(false);
  });
});
