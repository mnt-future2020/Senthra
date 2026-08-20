import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A guard against the single worst Prisma+MongoDB trap this schema can contain.
 *
 * `@unique` on an OPTIONAL scalar builds a NON-sparse unique index on MongoDB: null counts as a
 * value, so the SECOND row that leaves the field unset is rejected with a duplicate-key error
 * (prisma/prisma#23870). The damage is silent and delayed — the schema validates, the client
 * generates, every test passes, and the collection works perfectly until the moment a second
 * row without that field is written. Then that write path is dead for everyone.
 *
 * `PendingUpload.url` shipped exactly this: the ledger row is minted at signature time with no
 * url, so the second concurrent upload in the app's life would have failed — taking every direct
 * browser upload with it. Nothing in typecheck, lint, `prisma validate` or the suites could see
 * it; only the live index could.
 *
 * The supported way to express "unique when present" on MongoDB is a PARTIAL unique index created
 * out of band (`$runCommandRaw` + `partialFilterExpression`), which is what `ensureSkuUniqueIndex`,
 * `ensureBarcodeUniqueIndex`, `ensureEmployeeIdUniqueIndex` and `ensurePendingUploadUrlUniqueIndex`
 * do. So the rule here is absolute: an optional field NEVER carries `@unique`.
 */

const schema = readFileSync(fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url)), "utf8");

// A field declaration whose type ends in `?` and which also carries a `@unique` attribute.
// Applied per LINE: `\s` would span newlines and pair an optional field with the `@unique` of
// some later, unrelated one. `@@unique` (the composite, block-level form) is excluded by the
// `(?<!@)` — it indexes a tuple, where Mongo's null-equality problem does not apply the same way.
const OPTIONAL_UNIQUE = /^[ \t]*(\w+)[ \t]+\w+\?[ \t]+.*?(?<!@)@unique/;

describe("schema.prisma", () => {
  it("declares no optional field as @unique", () => {
    const offenders = schema
      .split("\n")
      .map((line) => OPTIONAL_UNIQUE.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(offenders).toEqual([]);
  });
});
