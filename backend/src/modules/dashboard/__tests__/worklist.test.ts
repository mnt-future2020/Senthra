import { describe, it, expect } from "vitest";
import { compareWorklist, type WorklistItem } from "../worklist.js";

const base = (over: Partial<WorklistItem>): WorklistItem => ({
  kind: "review_prf",
  id: "x",
  code: "PRF-1",
  title: null,
  priority: null,
  dueDate: null,
  ageDays: 0,
  href: "/x",
  ...over,
});

describe("compareWorklist", () => {
  const NOW = new Date("2026-07-09T12:00:00Z");

  it("orders overdue before due-today before high-priority before oldest", () => {
    const overdue = base({ id: "overdue", dueDate: "2026-07-01T00:00:00Z", ageDays: 8 });
    const dueToday = base({ id: "today", dueDate: "2026-07-09T18:00:00Z", ageDays: 1 });
    const high = base({ id: "high", priority: "high", ageDays: 2 });
    const old = base({ id: "old", ageDays: 5 });
    const sorted = [old, high, dueToday, overdue].sort((a, b) => compareWorklist(a, b, NOW));
    expect(sorted.map((r) => r.id)).toEqual(["overdue", "today", "high", "old"]);
  });

  it("within the oldest band, older (higher ageDays) comes first", () => {
    const a = base({ id: "a", ageDays: 3 });
    const b = base({ id: "b", ageDays: 9 });
    const sorted = [a, b].sort((x, y) => compareWorklist(x, y, NOW));
    expect(sorted.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("treats urgent like high in the priority band", () => {
    const urgent = base({ id: "u", priority: "urgent", ageDays: 1 });
    const plain = base({ id: "p", ageDays: 1 });
    const sorted = [plain, urgent].sort((x, y) => compareWorklist(x, y, NOW));
    expect(sorted[0].id).toBe("u");
  });
});
