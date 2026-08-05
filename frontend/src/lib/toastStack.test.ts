import { describe, expect, it } from "vitest";

import { MAX_TOASTS, pushToastStack, type Toast } from "./toastStack";

const stack = (...msgs: string[]): Toast[] =>
  msgs.map((msg, i) => ({ id: `t${i + 1}`, msg, type: "success", count: 1 }));

describe("pushToastStack", () => {
  it("adds a new message to the stack", () => {
    const r = pushToastStack([], "Copied IRM-0009", "success", "t1");
    expect(r.toasts).toHaveLength(1);
    expect(r.toasts[0]).toMatchObject({ id: "t1", msg: "Copied IRM-0009", count: 1 });
    expect(r.keepAlive).toBe("t1");
    expect(r.dropped).toEqual([]);
  });

  // The reason this module exists: nine clicks used to mean nine identical toasts covering the app.
  it("MERGES a repeat instead of stacking a duplicate", () => {
    let s: Toast[] = [];
    for (let i = 0; i < 9; i++) s = pushToastStack(s, "Copied IRM-0009", "success", `t${i + 1}`).toasts;
    expect(s).toHaveLength(1);
    expect(s[0]!.count).toBe(9);
  });

  // A merged toast must live from the LATEST occurrence, or it vanishes on the first one's clock
  // while the user is still clicking.
  it("restarts the clock of the toast it merged into", () => {
    const r = pushToastStack(stack("Copied IRM-0009"), "Copied IRM-0009", "success", "t99");
    expect(r.keepAlive).toBe("t1");
    expect(r.toasts.map((t) => t.id)).toEqual(["t1"]); // the fresh id is NOT used
  });

  it("keeps different messages apart", () => {
    const r = pushToastStack(stack("Copied IRM-0009"), "Copied IRM-0010", "success", "t2");
    expect(r.toasts).toHaveLength(2);
    expect(r.toasts.every((t) => t.count === 1)).toBe(true);
  });

  // Same words, different meaning — a failure must never be swallowed into a success already showing.
  it("does NOT merge the same text across types", () => {
    const existing: Toast[] = [{ id: "t1", msg: "Saved", type: "success", count: 1 }];
    const r = pushToastStack(existing, "Saved", "alert", "t2");
    expect(r.toasts).toHaveLength(2);
  });

  // The cap covers the other way a stack runs away: a burst of DIFFERENT messages.
  it("caps the stack and drops the oldest", () => {
    let s: Toast[] = [];
    const dropped: string[] = [];
    for (let i = 1; i <= MAX_TOASTS + 2; i++) {
      const r = pushToastStack(s, `msg ${i}`, "success", `t${i}`);
      s = r.toasts;
      dropped.push(...r.dropped);
    }
    expect(s).toHaveLength(MAX_TOASTS);
    expect(s[s.length - 1]!.msg).toBe(`msg ${MAX_TOASTS + 2}`); // newest kept
    expect(dropped).toEqual(["t1", "t2"]); // oldest reported so their timers can be cancelled
  });

  // A merge must not evict anything — the stack didn't grow.
  it("drops nothing when it merges", () => {
    let s: Toast[] = [];
    for (let i = 1; i <= MAX_TOASTS; i++) s = pushToastStack(s, `msg ${i}`, "success", `t${i}`).toasts;
    const r = pushToastStack(s, "msg 1", "success", "t99");
    expect(r.dropped).toEqual([]);
    expect(r.toasts).toHaveLength(MAX_TOASTS);
  });

  it("does not mutate the stack it was given", () => {
    const before = stack("Copied IRM-0009");
    pushToastStack(before, "Copied IRM-0009", "success", "t2");
    expect(before[0]!.count).toBe(1);
  });
});
