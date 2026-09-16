import { describe, expect, it } from "vitest";

import router from "./purchase-order.routes.js";

// Express matches routes in DECLARATION order, not by shape: a GET "/custom-fields" declared after
// GET "/:id" would be read as an order whose id is "custom-fields" and answer "Purchase order not found."
type Layer = { route?: { path: string; methods: Record<string, boolean> } };
const routes = (router as unknown as { stack: Layer[] }).stack
  .filter((l) => l.route)
  .map((l) => ({ path: l.route!.path, methods: Object.keys(l.route!.methods) }));
const indexOf = (method: string, path: string) => routes.findIndex((r) => r.path === path && r.methods.includes(method));

describe("purchase-order routes — custom-field definitions", () => {
  it("declares every custom-field route", () => {
    expect(indexOf("get", "/custom-fields")).toBeGreaterThanOrEqual(0);
    expect(indexOf("post", "/custom-fields")).toBeGreaterThanOrEqual(0);
    expect(indexOf("put", "/custom-fields/order")).toBeGreaterThanOrEqual(0);
    expect(indexOf("patch", "/custom-fields/:fieldId")).toBeGreaterThanOrEqual(0);
  });

  it("declares them before the '/:id' routes that would otherwise swallow them", () => {
    expect(indexOf("get", "/custom-fields")).toBeLessThan(indexOf("get", "/:id"));
    expect(indexOf("patch", "/custom-fields/:fieldId")).toBeLessThan(indexOf("patch", "/:id/delivery-date"));
  });
});
