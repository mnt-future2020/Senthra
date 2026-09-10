import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { outgoingPendingAction } from "./transferActions";

// The bug: "My requests" offered Cancel on every pending transfer the engineer was receiving, but the
// server lets only the REQUESTER cancel. An office-arranged transfer records the office user as
// requester, so the engineer got a button that always failed with a permission error.

const ENGINEER = "eng-recipient";

describe("outgoingPendingAction", () => {
  it("offers Cancel on a request the engineer raised themselves", () => {
    expect(outgoingPendingAction({ requestedById: ENGINEER }, ENGINEER)).toBe("cancel");
  });

  it("does not offer Cancel on a transfer the office arranged for the engineer", () => {
    expect(outgoingPendingAction({ requestedById: "office-user" }, ENGINEER)).toBe("arranged-by-office");
  });

  it("never offers Cancel when the viewer is not known", () => {
    for (const viewer of [null, undefined, ""]) {
      expect(outgoingPendingAction({ requestedById: ENGINEER }, viewer)).toBe("arranged-by-office");
    }
  });

  it("never offers Cancel on a row with no recorded requester", () => {
    expect(outgoingPendingAction({ requestedById: "" }, ENGINEER)).toBe("arranged-by-office");
    expect(outgoingPendingAction({ requestedById: "" }, "")).toBe("arranged-by-office");
  });
});

// There is no component-render harness in this suite, so the wiring is pinned at the source level —
// the same approach Sidebar.nav.test.ts takes. It fails if the row goes back to offering Cancel on
// every pending "My requests" transfer.
describe("EngineerTransfers — My requests row", () => {
  const code = readFileSync(
    join(process.cwd(), "src", "components", "dashboard", "engineer", "EngineerTransfers.tsx"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*/g, "");

  it("decides the outgoing action with outgoingPendingAction", () => {
    expect(code).toContain("outgoingPendingAction(");
  });

  it("renders Cancel only for the 'cancel' outcome", () => {
    expect(code).toMatch(/outgoingAction === "cancel" && \(/);
    expect(code, "Cancel must not be offered on every pending outgoing transfer").not.toMatch(
      /role === "outgoing" && transfer\.status === "pending" && \(/,
    );
  });

  it("shows the non-actionable office indicator otherwise", () => {
    expect(code).toMatch(/outgoingAction === "arranged-by-office" && \(/);
    expect(code).toContain("Arranged by office");
  });
});
