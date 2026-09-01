import type { Request } from "express";

// Read a route param as a single string. Express 5's types widen params to
// `string | string[]`; a named param like `:id` is always a single value at
// runtime, so we collapse the array case defensively.
export function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// Parse a query value as an integer, or undefined when it's absent / non-numeric —
// so list endpoints fall back to their defaults rather than passing NaN downstream.
export function queryInt(value: unknown): number | undefined {
  const n = typeof value === "string" ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

// Read a query value as a single string (or undefined). A DUPLICATED param (`?q=a&q=b`) arrives as
// an array — collapse to the first value rather than letting `typeof array === "string"` coerce the
// whole thing to undefined (which silently drops the filter). The single shared home for this so
// list endpoints don't each re-implement it (some with the weaker array-unaware form).
export function queryStr(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" ? v : undefined;
}

/**
 * Read a query value as a BOOLEAN. `1`/`true` are true, `0`/`false` are false, anything else —
 * absent, empty, misspelt — is `undefined`, meaning "the caller did not ask".
 *
 * This exists because the obvious shorthand is wrong in the one direction that matters:
 * `queryStr(q.flag) ? true : undefined` reads `?flag=false` as TRUE, because a non-empty string is
 * truthy. A caller switching a filter OFF then turns it ON, and on a filter that narrows a list that
 * shows up as rows silently disappearing rather than as an error.
 *
 * `1`/`true` BOTH accepted (and `0`/`false` both rejected) because the codebase had already grown
 * three spellings of this check — `=== "1"`, `=== "true"`, and `=== "1" || === "true"`. Accepting
 * the union is the only migration that breaks no existing caller: every value that used to mean
 * true still does, and the values that used to be silently ignored now mean false.
 *
 * Case-insensitive, so `?holding=True` from a hand-written URL behaves.
 */
export function queryBool(value: unknown): boolean | undefined {
  const v = queryStr(value)?.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return undefined;
}
