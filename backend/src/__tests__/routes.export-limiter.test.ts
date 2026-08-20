import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// A class-level guard, not a unit test.
//
// A CSV export is the most expensive read the API serves: it renders up to EXPORT_MAX rows into one
// in-memory string, and unlike a list endpoint it has no page to hide behind. `exportLimiter` is
// what stops a held-down refresh — or a script — from asking the process to build the whole register
// over and over. Every export route was given it; two of the newest were not, and nothing could see
// that, because a missing middleware is not a type error, not a lint error, and not a failing test.
// The endpoint simply works, faster than it should, until the day someone leans on it.
//
// The rule is positional, so state it once here rather than trusting seventeen route declarations to
// remember it: a GET whose handler is an export takes exportLimiter.

const SRC = join(import.meta.dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith(".routes.ts")) out.push(p);
  }
  return out;
}

/**
 * Every `router.get(...)` call in a routes file, as one flat string each.
 *
 * Route declarations are written both on one line and across several (the argument list grows a line
 * per middleware), so a line-based scan would miss exactly the long ones — which are the ones most
 * likely to have lost a middleware. Splitting on the call opener and taking up to the closing `);`
 * keeps each declaration whole regardless of how it is formatted.
 */
function getRoutes(src: string): string[] {
  return src
    .split("router.get(")
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf(");") + 1));
}

const files = walk(SRC).map((path) => ({
  rel: path.slice(SRC.length + 1).split("\\").join("/"),
  src: readFileSync(path, "utf8"),
}));

describe("export routes", () => {
  it("every CSV export is throttled by exportLimiter", () => {
    const unthrottled = files.flatMap(({ rel, src }) =>
      getRoutes(src)
        // The handler is what identifies an export — not the path. `/rental-lines/on-hire/export`
        // and `/export.csv` are both exports and neither spells it the same way.
        .filter((r) => /Controller\.export\w+/.test(r) && !r.includes("exportLimiter"))
        .map((r) => `${rel} → ${r.slice(0, r.indexOf(",")).trim()}`),
    );
    expect(unthrottled).toEqual([]);
  });

  // The guard is only worth anything if it can SEE the routes. A refactor that renames the files, or
  // moves a declaration behind a helper, would empty the scan above and turn it permanently green —
  // the failure mode of every source-scanning test. This is the canary for that.
  it("finds the export routes it is meant to be guarding", () => {
    const found = files.flatMap(({ src }) => getRoutes(src).filter((r) => /Controller\.export\w+/.test(r)));
    expect(found.length).toBeGreaterThanOrEqual(15);
  });
});
