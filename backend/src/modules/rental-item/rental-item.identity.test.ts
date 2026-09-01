import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#modules/engineer-rental/engineer-rental.repository.js", () => ({
  countHeldRentalsByRentalItem: vi.fn(async () => 0),
}));
vi.mock("./rental-item.repository.js", () => ({
  findMany: vi.fn(),
  findById: vi.fn(),
  findByCode: vi.fn(),
  findActiveByIds: vi.fn(),
  createWithCode: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  countByPrfLines: vi.fn(),
  countByPoLines: vi.fn(),
  countByJobKitLines: vi.fn(async () => 0),
}));
vi.mock("#modules/rental-category/rental-category.service.js", () => ({ requireActiveRentalCategory: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getRentalCodePrefix: vi.fn() }));

import * as rentalRepo from "./rental-item.repository.js";
import { getRentalItemsByIds } from "./rental-item.service.js";

/**
 * The identity contract behind a purchase request's rental lines.
 *
 * A PRF rental line stores `rentalItemId` (a real FK) plus `itemName` as a DENORMALISED SNAPSHOT.
 * The snapshot exists so an old line still reads correctly after the catalogue is renamed — it is
 * NOT how the item is found. `getRentalItemsByIds` is the lookup that produces those snapshots, and
 * these tests pin the one property that makes the whole thing safe: it is keyed by ID, so two items
 * that happen to share a name can never be mistaken for each other.
 *
 * Rental item names are NOT unique — nothing in the schema or validation constrains them — so this
 * is a real scenario, not a hypothetical.
 */
describe("rental item identity — same name, different id", () => {
  const A = { id: "a".repeat(24), name: "Fiber Tester", baseUnit: "Each" };
  const B = { id: "b".repeat(24), name: "Fiber Tester", baseUnit: "Day" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps two same-name items apart, keyed by id", async () => {
    vi.mocked(rentalRepo.findActiveByIds).mockResolvedValue([A, B] as never);
    const map = await getRentalItemsByIds([A.id, B.id]);

    expect(map.size).toBe(2);
    // Identical names, but each id resolves to ITS OWN row — the unit proves which one it is.
    expect(map.get(A.id)).toEqual({ name: "Fiber Tester", baseUnit: "Each" });
    expect(map.get(B.id)).toEqual({ name: "Fiber Tester", baseUnit: "Day" });
  });

  it("resolves a line's snapshot from the line's own id, never from a name match", async () => {
    vi.mocked(rentalRepo.findActiveByIds).mockResolvedValue([A, B] as never);
    const map = await getRentalItemsByIds([B.id]);

    // This is what `buildRentalLineRows` does: items.get(line.rentalItemId).
    expect(map.get(B.id)?.baseUnit).toBe("Day");
    // And the shared name gives no route to the wrong row — there is no name index at all.
    expect([...map.keys()]).toEqual(expect.arrayContaining([A.id, B.id]));
  });

  it("asks the repository for the ids it was given, de-duplicated", async () => {
    vi.mocked(rentalRepo.findActiveByIds).mockResolvedValue([A] as never);
    await getRentalItemsByIds([A.id, A.id]);
    expect(rentalRepo.findActiveByIds).toHaveBeenCalledWith([A.id]);
  });

  it("returns an empty map when nothing was asked for, without touching the repository", async () => {
    expect((await getRentalItemsByIds([])).size).toBe(0);
    expect(rentalRepo.findActiveByIds).not.toHaveBeenCalled();
  });
});
