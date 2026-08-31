import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The STRUCTURAL guard on filter → export parity, across every module at once.
 *
 * Every parity bug this codebase has had was the same shape and none of them failed to compile: the
 * list handler and the export handler each read `req.query` with their own object literal, and one
 * of the two was shorter. Inventory lost `irmItem`; the on-hire register lost four filters; the
 * customer-stock export lost its whole date window. A per-module test only catches the module it was
 * written for, and the next export added is the one nobody writes a test for.
 *
 * So this asserts the RULE rather than any single export: an export handler must not pick fields off
 * the query string itself. It must delegate to the same parser its list handler uses, which is the
 * only arrangement where a newly added filter cannot reach the screen without also reaching the file.
 *
 * Passing `req.query` WHOLE to a named parser (`movementFiltersFrom(req.query)`) is the one accepted
 * form of contact — that IS the shared parser, and the movement list calls the identical function.
 * What is rejected is `req.query.status`, or destructuring it and reading fields off the result.
 */

const MODULES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every controller in every module. Walked rather than listed, so a new module is covered on sight. */
function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return controllerFiles(full);
    return full.endsWith(".controller.ts") ? [full] : [];
  });
}

/** Every `export…Csv` / `export…Xlsx` asyncHandler body, with the file it came from. */
function exportHandlers(): { file: string; name: string; body: string }[] {
  const out: { file: string; name: string; body: string }[] = [];
  for (const file of controllerFiles(MODULES)) {
    const src = readFileSync(file, "utf8");
    const re = /export const (export\w*(?:Csv|Xlsx)) = asyncHandler\(async \(req, res\) => \{([\s\S]*?)\n\}\);/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      out.push({ file: path.relative(MODULES, file).split(path.sep).join("/"), name: m[1]!, body: m[2]! });
    }
  }
  return out;
}

const handlers = exportHandlers();

describe("every CSV/XLSX export delegates its filters to the list's parser", () => {
  it("finds the export handlers at all — a silent zero would make every assertion below vacuous", () => {
    expect(handlers.length).toBeGreaterThan(20);
  });

  it.each(handlers.map((h) => [`${h.file} :: ${h.name}`, h] as const))(
    "%s does not read individual query fields",
    (_label, h) => {
      // `req.query.foo` — reading one filter by hand is how the other one gets forgotten.
      expect(h.body).not.toMatch(/req\.query\s*\.\s*\w/);
      // `const q = req.query` / `const { status } = req.query` — the same thing one line later.
      expect(h.body).not.toMatch(/=\s*req\.query\s*[;,\n]/);
    },
  );

  it.each(handlers.map((h) => [`${h.file} :: ${h.name}`, h] as const))(
    "%s does not inherit the list's paging — an export is the whole filtered set",
    (_label, h) => {
      // A page/pageSize literal inside an export handler means the file stops at the rows on screen.
      expect(h.body).not.toMatch(/\bpage\s*:/);
      expect(h.body).not.toMatch(/\bpageSize\s*:/);
      expect(h.body).not.toMatch(/\bcursor\s*:(?!\s*null)/);
    },
  );
});

describe("every export answers through the shared CSV/XLSX response helper", () => {
  it.each(handlers.map((h) => [`${h.file} :: ${h.name}`, h] as const))(
    "%s uses sendCsv (or sets the xlsx headers explicitly)",
    (_label, h) => {
      // sendCsv is what stamps the UTF-8 BOM, the dated filename and — the one that bites —
      // X-Export-Capped, without which a truncated file is handed over as a complete one.
      const answered = /sendCsv\(/.test(h.body) || /XLSX_MIME|Content-Disposition/.test(h.body);
      expect(answered).toBe(true);
    },
  );
});
