import type { Request } from "express";

// Read a route param as a single string. Express 5's types widen params to
// `string | string[]`; a named param like `:id` is always a single value at
// runtime, so we collapse the array case defensively.
export function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
