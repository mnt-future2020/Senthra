import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Guard against mojibake in the source tree.
//
// A file written as UTF-8 and then re-saved through a legacy code page (Windows-1252) turns
// every non-ASCII character into a run of Latin-1 lookalikes: an em dash or an arrow decays
// into two or three garbage glyphs starting with U+00C2/U+00C3/U+00E2. TypeScript, ESLint and
// `next build` all accept those bytes happily - the damage only shows up in the browser, in
// whatever screen happens to render that string. It has already happened twice in this repo
// (see .editorconfig), so it gets a test rather than a comment.
//
// The .editorconfig `charset = utf-8` rule prevents it at save time in a configured editor;
// this test catches anything that slips past (a different editor, a paste, a bad patch).
//
// Everything this file matches on is written as a \u escape rather than a literal, and the
// comments stay ASCII, so the scanner is clean under its own rules instead of exempting itself.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const SCAN_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".md", ".prisma", ".html"];

// The three lead characters a UTF-8 sequence decays into under Windows-1252/Latin-1:
// U+00C2, U+00C3, U+00E2. On their own they are legitimate letters (a-circumflex, A-tilde,
// A-circumflex appear in real French/Portuguese words), so a match only counts when the NEXT
// character is ALSO non-ASCII - which is what a decayed multi-byte sequence always looks like
// and ordinary prose never does.
const MOJIBAKE = /[\u00C2\u00C3\u00E2][^\u0000-\u007F]/;

// U+FFFD is what Node substitutes for bytes that are not valid UTF-8 at all, so its presence
// means the file is already damaged. U+FEFF is a byte-order mark: it must not LEAD a source
// file (it breaks JSON parsers and shebangs), but it is legitimate mid-string - the CSV export
// endpoints deliberately prepend one so Excel opens the download as UTF-8.
const REPLACEMENT_CHAR = "\uFFFD";
const BOM = "\uFEFF";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(join(dir, entry.name), out);
    } else if (SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** One scanned file: its repo-relative label, and its contents read exactly once. */
interface Source {
  label: string;
  contents: string;
}

function readSources(dir: string): Source[] {
  return sourceFiles(dir).map((file) => ({
    label: relative(REPO_ROOT, file).split(sep).join("/"),
    contents: readFileSync(file, "utf8"),
  }));
}

// "path:line - offending text" for every hit, so a failure points straight at the fix.
function badLines(src: Source, test: (line: string) => boolean): string[] {
  return src.contents
    .split("\n")
    .map((line, i) => (test(line) ? `${src.label}:${i + 1} - ${line.trim()}` : null))
    .filter((hit): hit is string => hit !== null);
}

describe("source text encoding", () => {
  // Walked AND read once, out here rather than inside each assertion.
  //
  // The three cases below used to re-read the whole tree with readFileSync, so the source of all
  // three apps came off the disk three times over. Run alone that finished in about four seconds;
  // run inside the full suite, sharing a disk with eighty-odd other test files, it did not - and
  // the cases failed at random with "Test timed out in 5000ms". That is the worst way for this
  // file to fail: a red build blaming the encoding guard for a busy disk, on a check whose whole
  // job is to be trusted when it does go red.
  //
  // Module scope is evaluated at collection time and is not subject to the per-test timeout, so
  // the reading is bounded by the disk instead of by a clock, and the assertions become pure
  // in-memory scans. Cheaper too: one pass over the tree instead of three.
  const sources = readSources(REPO_ROOT);

  it("finds source files to scan", () => {
    // Cheap canary: if the walk breaks, the other assertions would pass on an empty list.
    expect(sources.length).toBeGreaterThan(100);
  });

  it("has no Windows-1252 mojibake", () => {
    const hits = sources.flatMap((src) => badLines(src, (line) => MOJIBAKE.test(line)));
    expect(hits).toEqual([]);
  });

  it("has no invalid UTF-8 bytes", () => {
    const hits = sources.flatMap((src) => badLines(src, (line) => line.includes(REPLACEMENT_CHAR)));
    expect(hits).toEqual([]);
  });

  it("has no leading byte-order mark", () => {
    const hits = sources.filter((src) => src.contents.startsWith(BOM)).map((src) => src.label);
    expect(hits).toEqual([]);
  });
});
