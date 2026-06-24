import { describe, expect, it } from "vitest";

// Mock lib/prisma so importing the repository never constructs a real Prisma client —
// buildWhere is a pure where-clause builder with no I/O.
import { vi } from "vitest";
vi.mock("../../lib/prisma.js", () => ({ prisma: {} }));

import { buildWhere } from "./purchase-order.repository.js";

describe("buildWhere — PO list status filtering", () => {
  it("maps a single status to an equality filter (backward compatible)", () => {
    expect(buildWhere({ status: "sent" }).status).toBe("sent");
  });

  it("maps multiple statuses to an `in` filter", () => {
    expect(buildWhere({ statuses: ["sent", "partially_received"] }).status).toEqual({
      in: ["sent", "partially_received"],
    });
  });

  it("prefers `statuses` over a single `status` when both are given", () => {
    expect(buildWhere({ status: "draft", statuses: ["sent", "partially_received"] }).status).toEqual({
      in: ["sent", "partially_received"],
    });
  });

  it("ignores an empty `statuses` array and falls back to `status`", () => {
    expect(buildWhere({ status: "sent", statuses: [] }).status).toBe("sent");
  });

  it("always excludes soft-deleted rows", () => {
    expect(buildWhere({}).deletedAt).toBeNull();
    expect(buildWhere({}).status).toBeUndefined();
  });
});
