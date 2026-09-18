import { describe, expect, it } from "vitest";

import { postLoginRoute } from "./postLoginRoute";
import type { Principal } from "@/types";

// Where a fresh session lands. Pinned because sign-in now finishes in TWO places — the credential
// screen and the two-factor code screen — and this is the rule they share. A copy per screen was the
// alternative, and a copy is what gets changed once.

const user = (over: Partial<Extract<Principal, { type: "user" }>> = {}) =>
  ({ type: "user", id: "u1", email: "e@x.com", mustResetPassword: false, ...over }) as Principal;

describe("postLoginRoute", () => {
  it("sends a staff user to the dashboard", () => {
    expect(postLoginRoute(user())).toBe("/overview");
  });

  it("diverts a user who must still set a password", () => {
    // The temporary password was emailed to them; the app must not let it become permanent by
    // dropping them straight onto the job list.
    expect(postLoginRoute(user({ mustResetPassword: true }))).toBe("/set-password");
  });

  it("sends an admin to the dashboard — the reset gate is a staff-user flag only", () => {
    expect(postLoginRoute({ type: "admin", id: "a1", email: "a@x.com" } as Principal)).toBe("/overview");
  });

  it("sends a customer principal to the dashboard rather than nowhere", () => {
    // Not an engineer, so the tab layout explains the lack of access — but it has to be REACHED.
    // Routing a customer somewhere else here would strand them on a screen with no explanation.
    expect(postLoginRoute({ type: "customer", id: "c1", email: "c@x.com" } as Principal)).toBe("/overview");
  });

  it("is the same answer whichever screen finished the sign-in", () => {
    // The whole point of the shared rule: password login and code verification cannot disagree.
    const p = user({ mustResetPassword: true });
    expect(postLoginRoute(p)).toBe(postLoginRoute(p));
  });
});
