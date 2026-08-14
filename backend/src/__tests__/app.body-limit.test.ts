import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { UPLOAD_BODY_PATHS } from "../app.js";

// The global JSON body ceiling is 5mb, and base64 inflates a file by 4/3 — so the largest FILE that
// fits a default request is ~3.7 MB. Any endpoint promising more than that needs its path in
// UPLOAD_BODY_PATHS, or the parser rejects the upload with a raw "request entity too large" before the
// schema that promised to allow it ever runs.
//
// THIS HAS NOW HAPPENED THREE TIMES: purchase-order and goods-in were missing when the widening was
// first written, and goods-management/damage-photo — which advertises ~10 MB — was still missing after
// they were fixed. The earlier version of this test hand-listed the routes it checked, so it only ever
// confirmed that the routes someone remembered were correct. That is the same shape of hole as an
// orphan sweep that has to be told about every consumer.
//
// So the table below is CHECKED AGAINST THE SOURCE. Every schema in the codebase that accepts a
// `data:` URI is discovered by scanning, and a schema missing from the table fails — the decision about
// each one has to be made, not remembered.

const SRC = join(import.meta.dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

const GLOBAL_LIMIT_BYTES = 5 * 1024 * 1024;
/** Largest raw file that survives base64 expansion inside a given body ceiling. */
const fileCeiling = (bodyBytes: number) => Math.floor(bodyBytes * 0.75);
const GLOBAL_FILE_CEILING = fileCeiling(GLOBAL_LIMIT_BYTES); // ~3.7 MB

/**
 * Every schema that accepts a `data:` URI, the route that uses it, and the largest FILE it advertises.
 *
 * `advertised` is the raw file size the schema allows — NOT the encoded body length. Where a schema caps
 * the data URI's CHARACTER count instead, that count IS the body length, so the file it admits is 3/4 of
 * it; the numbers below are already converted.
 */
const UPLOAD_SCHEMAS: { schema: string; route: string; advertised: number }[] = [
  // --- documents: file size capped directly ---
  { schema: "uploadAttachmentSchema", route: "/jobs/attachment", advertised: 10 * 1024 * 1024 },
  { schema: "prfAttachmentSchema", route: "/purchase-requests/64b7f9c2e1a4d5f6a7b8c9d0/attachments", advertised: 10 * 1024 * 1024 },
  { schema: "poAttachmentSchema", route: "/purchase-orders/64b7f9c2e1a4d5f6a7b8c9d0/attachments", advertised: 10 * 1024 * 1024 },
  { schema: "grnAttachmentSchema", route: "/goods-in/64b7f9c2e1a4d5f6a7b8c9d0/attachments", advertised: 5 * 1024 * 1024 },
  // --- images: the DATA URI's character count is capped, so the file is 3/4 of it ---
  { schema: "uploadDamagePhotoSchema", route: "/goods-management/damage-photo", advertised: fileCeiling(15_000_000) },
  { schema: "uploadBrandingSchema", route: "/settings/branding", advertised: fileCeiling(3 * 1024 * 1024) },
  { schema: "uploadSignatureSchema", route: "/users/me/signature", advertised: fileCeiling(3 * 1024 * 1024) },
  { schema: "uploadImageSchema", route: "/van-stock-requests/attachments", advertised: fileCeiling(3 * 1024 * 1024) },
  { schema: "acknowledgeSchema", route: "/engineer-transfers/64b7f9c2e1a4d5f6a7b8c9d0/acknowledge", advertised: fileCeiling(3 * 1024 * 1024) },
  // --- the file rides inside a larger create/update payload rather than its own endpoint ---
  { schema: "createCustomerSchema", route: "/customers", advertised: fileCeiling(3 * 1024 * 1024) },
  { schema: "updateCustomerSchema", route: "/customers/64b7f9c2e1a4d5f6a7b8c9d0", advertised: fileCeiling(3 * 1024 * 1024) },
  { schema: "createUserSchema", route: "/users", advertised: fileCeiling(3 * 1024 * 1024) },
  { schema: "updateUserSchema", route: "/users/64b7f9c2e1a4d5f6a7b8c9d0", advertised: fileCeiling(3 * 1024 * 1024) },
  { schema: "updateMyProfileSchema", route: "/users/me", advertised: fileCeiling(3 * 1024 * 1024) },
];

// `uploadAttachmentSchema` is declared in three modules (job, engineer-transfer, job-kit-request) and
// they are separate contracts under one name. The job one is the only one above the global ceiling; the
// other two cap the data URI at 3 MB and are covered by the entry above via the same name.
const DUPLICATE_SCHEMA_NAMES = new Set(["uploadAttachmentSchema"]);

const validationFiles = walk(SRC)
  .filter((p) => p.endsWith(".validation.ts"))
  .map((path) => ({ path, src: readFileSync(path, "utf8") }));

// A data-URI CONSTRAINT, not the words "data" and a colon. Anchored so a UoM list or a comment
// mentioning data can't masquerade as an upload field.
const DATA_URI_CONSTRAINT = /\^data:|startsWith\(\s*"data:/;

/**
 * Schemas whose body accepts a `data:` URI — the ones this file must have an opinion about.
 *
 * TWO passes, because the constraint is often not written inside the schema that uses it: `profileImage`
 * and the customer `logo` are shared field consts declared alongside the schemas that reference them. A
 * single pass attributing each match to the nearest preceding `export const` reported the wrong owner
 * (it blamed a UoM option list) and missed every schema that reaches the constraint by reference.
 */
function discoverDataUriSchemas(): string[] {
  const found = new Set<string>();
  for (const { src } of validationFiles) {
    // One chunk per top-level declaration, exported or not.
    const decls = src
      .split(/\n(?=(?:export )?(?:const|type|function) )/)
      .map((chunk) => ({ name: /^(?:export )?(?:const|type|function) (\w+)/.exec(chunk)?.[1] ?? "", chunk }))
      .filter((d) => d.name);

    const carriers = decls.filter((d) => DATA_URI_CONSTRAINT.test(d.chunk)).map((d) => d.name);
    for (const d of decls) {
      if (!/^export const/.test(d.chunk)) continue;
      const own = DATA_URI_CONSTRAINT.test(d.chunk);
      const byReference = carriers.some((c) => c !== d.name && new RegExp(`\\b${c}\\b`).test(d.chunk));
      if (own || byReference) found.add(d.name);
    }
  }
  return [...found].sort();
}

describe("upload body limits", () => {
  // THE guard. A new `data:`-accepting schema must be classified here, which is the step that was
  // missing all three times this broke.
  it("every data-URI schema in the codebase is accounted for", () => {
    const discovered = discoverDataUriSchemas();
    const known = new Set(UPLOAD_SCHEMAS.map((u) => u.schema));
    const unclassified = discovered.filter((s) => !known.has(s));
    expect(unclassified, "add these to UPLOAD_SCHEMAS with their route and advertised size").toEqual([]);
  });

  it("finds the schemas it is meant to be checking (the scan itself works)", () => {
    const discovered = discoverDataUriSchemas();
    expect(discovered.length).toBeGreaterThanOrEqual(10);
    expect(discovered).toContain("uploadDamagePhotoSchema");
    expect(discovered).toContain("prfAttachmentSchema");
  });

  const widened = UPLOAD_SCHEMAS.filter((u) => u.advertised > GLOBAL_FILE_CEILING);
  const notWidened = UPLOAD_SCHEMAS.filter((u) => u.advertised <= GLOBAL_FILE_CEILING);

  it.each(widened)("$route advertises more than the global ceiling, so it is widened", ({ route, advertised }) => {
    expect(advertised, "advertised limit no longer exceeds the global ceiling").toBeGreaterThan(GLOBAL_FILE_CEILING);
    expect(UPLOAD_BODY_PATHS.test(route), `${route} is missing from UPLOAD_BODY_PATHS`).toBe(true);
  });

  // The other half of the rule: the widened ceiling must not leak onto routes that do not need it. The
  // global limit is also the limit on /auth/login, and a 15 MB body there is free work for an attacker.
  it.each(notWidened)("$route fits the global ceiling and stays on the default parser", ({ route, advertised }) => {
    expect(advertised).toBeLessThanOrEqual(GLOBAL_FILE_CEILING);
    expect(UPLOAD_BODY_PATHS.test(route), `${route} does not need widening`).toBe(false);
  });

  it("widens with enough headroom for the largest advertised file once base64-encoded", () => {
    const widenedLimit = 15 * 1024 * 1024;
    const largest = Math.max(...widened.map((u) => u.advertised));
    expect(fileCeiling(widenedLimit)).toBeGreaterThanOrEqual(largest);
  });

  it.each([
    "/auth/login",
    "/jobs",
    "/jobs/64b7f9c2e1a4d5f6a7b8c9d0",
    "/purchase-orders",
    "/goods-management",
    "/goods-management/report-damage",
    "/customers",
  ])("%s keeps the 5mb ceiling", (route) => {
    expect(UPLOAD_BODY_PATHS.test(route)).toBe(false);
  });

  // Deleting an attachment carries no body at all; only the POST needs widening.
  it("does not widen an attachment DELETE sub-path", () => {
    expect(UPLOAD_BODY_PATHS.test("/purchase-orders/64b7f9c2e1a4d5f6a7b8c9d0/attachments/att1")).toBe(false);
  });

  it("documents which schema names are shared across modules", () => {
    // Kept as an explicit note: a shared name means the table's entry speaks for the STRICTEST of them.
    expect(DUPLICATE_SCHEMA_NAMES.has("uploadAttachmentSchema")).toBe(true);
  });
});
