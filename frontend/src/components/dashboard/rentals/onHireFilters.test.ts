import { describe, expect, it } from "vitest";

import type { OnHireFilter } from "@/types/rental";

/**
 * A BADGE THAT OPENS THE WRONG SCREEN IS WORSE THAN NO BADGE.
 *
 * `OnHireView` clamps an unrecognised `?status=` back to "all":
 *
 *     const status = FILTERS.some((f) => f.id === requested) ? requested! : "all";
 *
 * That is right — a typed URL must not blank the register — but it means every status the SERVER
 * answers has to exist here too. `rentals.custody_to_settle` links to `?status=custody`, the backend
 * has answered it since the badge existed, and this list did not: the badge counted N, opened the
 * whole register with no pill lit, and left nobody able to find the rows it was talking about.
 *
 * This is the mirror the clamp needs. Every status the badges link to is listed, so adding a filter
 * on one side and forgetting the other fails here instead of on somebody's screen.
 */
const FILTER_IDS: OnHireFilter[] = ["all", "late", "expiring", "overdue", "custody", "returned", "cancelled"];

/** The `href` each rentals badge in the attention registry opens. */
const BADGE_STATUSES: Record<string, OnHireFilter> = {
  "rentals.expiring_soon": "expiring",
  "rentals.overdue": "overdue",
  "rentals.awaiting_delivery": "late",
  "rentals.custody_to_settle": "custody",
};

const resolve = (requested: string | null): OnHireFilter =>
  FILTER_IDS.some((f) => f === requested) ? (requested as OnHireFilter) : "all";

describe("every rentals badge lands on a filter this list has", () => {
  it.each(Object.entries(BADGE_STATUSES))("%s opens %s", (_key, status) => {
    expect(resolve(status)).toBe(status);
  });

  // The regression itself, stated on its own so the reason survives the fix.
  it("resolves ?status=custody rather than clamping it to the whole register", () => {
    expect(resolve("custody")).toBe("custody");
    expect(resolve("custody")).not.toBe("all");
  });

  // The clamp still has to work — a typed or stale URL must show something, not nothing.
  it("still clamps a status nobody serves", () => {
    expect(resolve("nonsense")).toBe("all");
    expect(resolve(null)).toBe("all");
  });
});
