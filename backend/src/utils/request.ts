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
