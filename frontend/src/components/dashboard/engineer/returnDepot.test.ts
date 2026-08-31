import { describe, expect, it } from "vitest";
import {
  canAddRental,
  effectiveReturnWarehouse,
  refusedRentalRows,
  returnDepotFor,
  returnWarehouseOptions,
  unitsAtDepot,
  type DepotBearingLine,
} from "./returnDepot";

// The rule these hold: a hire goes back to the warehouse of its own order, because the model has
// nowhere to record it coming back anywhere else. The server enforces that at create, at scan and
// inside the posting transaction. What is tested here is the FORM's half — deciding the destination
// instead of asking for it, and refusing a combination that could never be posted.

const A = { warehouseId: "wa", warehouseName: "London Logistics Hub", qty: 2 };
const B = { warehouseId: "wb", warehouseName: "London Fulfillment Centre", qty: 3 };

const rental = (...depots: { warehouseId: string; warehouseName: string; qty: number }[]): DepotBearingLine => ({ source: "rental", depots });
const irm = (): DepotBearingLine => ({ source: "irm", depots: [] });

describe("returnDepotFor", () => {
  it("leaves an IRM-only cart free to pick any warehouse", () => {
    // Company stock has a real balance per (item, warehouse), so any warehouse can take it back.
    expect(returnDepotFor([irm(), irm()])).toEqual({ kind: "free" });
    expect(returnDepotFor([])).toEqual({ kind: "free" });
  });

  it("fixes the destination to the depot the first hire came from", () => {
    expect(returnDepotFor([rental(A)])).toEqual({ kind: "fixed", ...A });
  });

  it("keeps the hire's depot when company stock rides along", () => {
    // IRM does not have to behave like a hire — it just travels to a warehouse that can book it in.
    expect(returnDepotFor([rental(A), irm()])).toEqual({ kind: "fixed", ...A });
    expect(returnDepotFor([irm(), rental(A), irm()])).toEqual({ kind: "fixed", ...A });
  });

  it("stays fixed when a second hire is from the same depot", () => {
    expect(returnDepotFor([rental(A), rental(A)])).toEqual({ kind: "fixed", ...A });
  });

  it("offers only the shared depots when one row spans two", () => {
    // A single catalogue row can sit on hires at two depots. Both are still valid destinations for it,
    // so the choice survives — narrowed to what every hired row can actually go back to.
    expect(returnDepotFor([rental(A, B)])).toEqual({ kind: "restricted", options: [A, B] });
    expect(returnDepotFor([rental(A, B), rental(A)])).toEqual({ kind: "fixed", ...A });
  });

  it("refuses to guess when a hire carries no resolvable depot", () => {
    // Never fall back to an arbitrary warehouse: without the depot there is no way to know which
    // counter can take it, and any pick would build a request the posting must refuse.
    expect(returnDepotFor([rental()])).toEqual({ kind: "unknown" });
    expect(returnDepotFor([rental(A), rental()])).toEqual({ kind: "unknown" });
  });

  it("refuses to guess when two hires share no depot at all", () => {
    // Unreachable through `canAddRental`, but a restored cart could still hold it.
    expect(returnDepotFor([rental(A), rental(B)])).toEqual({ kind: "unknown" });
  });

  it("returns to a free picker once the last hire leaves the cart", () => {
    const cart = [rental(A), irm()];
    expect(returnDepotFor(cart.filter((l) => l.source !== "rental"))).toEqual({ kind: "free" });
  });
});

describe("canAddRental", () => {
  it("always allows company stock", () => {
    expect(canAddRental([rental(A)], irm())).toEqual({ ok: true });
  });

  it("allows the first hire, whatever its depot", () => {
    expect(canAddRental([], rental(B))).toEqual({ ok: true });
    expect(canAddRental([irm()], rental(B))).toEqual({ ok: true });
  });

  it("allows a second hire from the same depot", () => {
    expect(canAddRental([rental(A)], rental(A))).toEqual({ ok: true });
  });

  it("allows a hire that shares one of several depots", () => {
    expect(canAddRental([rental(A, B)], rental(B))).toEqual({ ok: true });
  });

  it("refuses a hire from a different depot, naming where it must go", () => {
    const res = canAddRental([rental(A)], rental(B));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe(
      "This item was collected from London Fulfillment Centre. Create a separate return for that depot.",
    );
  });

  it("never puts an internal id in the refusal", () => {
    const res = canAddRental([rental(A)], rental(B));
    expect(res.ok === false && res.reason).not.toContain("wb");
  });

  it("names every depot a multi-depot candidate could go to", () => {
    const C = { warehouseId: "wc", warehouseName: "Leeds Depot", qty: 1 };
    const res = canAddRental([rental(A)], rental(B, C));
    expect(res.ok === false && res.reason).toContain("London Fulfillment Centre or Leeds Depot");
  });

  it("refuses a hire whose depot could not be resolved, rather than guessing", () => {
    const res = canAddRental([rental(A)], rental());
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/couldn't work out which depot/i);
  });

  it("is a pure check — it never mutates the cart it is given", () => {
    const cart = [rental(A), irm()];
    const snapshot = JSON.stringify(cart);
    canAddRental(cart, rental(B));
    expect(JSON.stringify(cart)).toBe(snapshot);
  });
});

describe("refusedRentalRows", () => {
  // The picker's half of the same rule. A refusal the engineer meets only AFTER tapping — and then as a
  // banner below the reason box, off the bottom of a phone screen — is a refusal they have to go looking
  // for. These pin the verdict to the row, before the tap.
  const keyOf = (r: DepotBearingLine & { key: string }) => r.key;
  const never = () => false;
  const row = (key: string, ...depots: { warehouseId: string; warehouseName: string; qty: number }[]) => ({ key, source: "rental", depots });
  const irmRow = (key: string) => ({ key, source: "irm", depots: [] });

  it("refuses nothing while the cart holds no hire", () => {
    // The first hire tapped sets the depot, whichever one it is — so nothing may be greyed out yet.
    expect(refusedRentalRows([], [row("a", A), row("b", B)], keyOf, never).size).toBe(0);
    expect(refusedRentalRows([irm()], [row("b", B)], keyOf, never).size).toBe(0);
  });

  it("refuses the rows from a depot the cart cannot reach, and only those", () => {
    const refused = refusedRentalRows([rental(A)], [row("a", A), row("b", B)], keyOf, never);
    expect(refused.get("b")).toBe("other-depot");
    expect(refused.has("a")).toBe(false);
  });

  it("never refuses company stock, whatever depot the cart is pinned to", () => {
    expect(refusedRentalRows([rental(A)], [irmRow("i")], keyOf, never).size).toBe(0);
  });

  it("marks a hire with no resolvable depot separately — it has no depot line to hang a reason on", () => {
    expect(refusedRentalRows([rental(A)], [row("x")], keyOf, never).get("x")).toBe("unknown-depot");
  });

  it("stays silent about a row already in the cart — \"added\" is the more useful thing to say", () => {
    const refused = refusedRentalRows([rental(A)], [row("b", B)], keyOf, (k) => k === "b");
    expect(refused.size).toBe(0);
  });

  it("agrees with canAddRental on every row it judges", () => {
    // The banner path and the row path must never disagree: one says why, the other decides the tap.
    const rows = [row("a", A), row("b", B), row("ab", A, B), row("none"), irmRow("i")];
    const refused = refusedRentalRows([rental(A)], rows, keyOf, never);
    for (const r of rows) {
      expect(refused.has(r.key)).toBe(!canAddRental([rental(A)], r).ok);
    }
  });

  it("frees the rows again once the last hire leaves the cart", () => {
    expect(refusedRentalRows([irm()], [row("a", A), row("b", B)], keyOf, never).size).toBe(0);
  });

  it("is a pure check — it never mutates the cart or the rows it is given", () => {
    const cart = [rental(A)];
    const rows = [row("b", B)];
    const snapshot = JSON.stringify([cart, rows]);
    refusedRentalRows(cart, rows, keyOf, never);
    expect(JSON.stringify([cart, rows])).toBe(snapshot);
  });
});

// ONE RETURN GOES TO ONE COUNTER, so a row summed across two depots is not postable at its own total.
//
// A hired row rolls up every hire its units sit on. Two hires of the same tester — 2 collected from the
// Logistics Hub, 3 from the Fulfilment Centre — is ONE row of 5, and 5 can be handed in at neither: the
// server checks the depot's own holding and refuses. The composer offered the 5 anyway, so the engineer
// met the refusal after the form was filled in, with nothing on screen having said to split it.
//
// The split is the fix, and the direction of the guarantee is what makes it safe: this only ever
// TIGHTENS the row's own cap. `null` means "no narrower ceiling than the row already has".
describe("unitsAtDepot", () => {
  it("caps a two-depot row at what that depot actually holds", () => {
    const row = rental(A, B);
    expect(unitsAtDepot(row, A.warehouseId)).toBe(2);
    expect(unitsAtDepot(row, B.warehouseId)).toBe(3);
  });

  it("adds no ceiling to a single-depot row — its own total already IS the depot's", () => {
    expect(unitsAtDepot(rental(A), A.warehouseId)).toBeNull();
  });

  it("adds no ceiling to company stock, which has no source depot", () => {
    expect(unitsAtDepot(irm(), A.warehouseId)).toBeNull();
  });

  it("adds no ceiling before a destination is chosen", () => {
    // The restricted picker starts empty. A cap of 0 here would read as "nothing may go back".
    expect(unitsAtDepot(rental(A, B), "")).toBeNull();
  });

  it("refuses to guess for a depot the row does not name", () => {
    // Not 0 and not the roll-up: the row says nothing about this warehouse, so neither does this.
    expect(unitsAtDepot(rental(A, B), "wc")).toBeNull();
  });

  it("is a pure read — it never mutates the row", () => {
    const row = rental(A, B);
    const snapshot = JSON.stringify(row);
    unitsAtDepot(row, A.warehouseId);
    expect(JSON.stringify(row)).toBe(snapshot);
  });
});

// AN UNRESOLVED DEPOT MUST OFFER NOTHING — the fault these hold shut.
//
// `unknown` means a hired row whose collection depot could not be read. It used to be folded in with
// `free`, so the picker listed EVERY active warehouse: every one of them a guess, any of them
// selectable, and the submit guard — which only asks whether a destination is a non-empty string —
// waved the guess through. The engineer filled the form in and the request died at the counter, while
// the message under the field said the opposite ("we couldn't work out which depot… ").
//
// Nothing to offer, and nothing derivable from a pick, is what makes that message true.
const ALL = [
  { value: "wa", label: "London Logistics Hub" },
  { value: "wb", label: "London Fulfillment Centre" },
  { value: "wc", label: "Bristol Depot" },
];

describe("returnWarehouseOptions", () => {
  it("offers NOTHING for an unresolved depot", () => {
    expect(returnWarehouseOptions({ kind: "unknown" }, ALL)).toEqual([]);
  });

  it("offers everything only when no hire is involved", () => {
    expect(returnWarehouseOptions({ kind: "free" }, ALL)).toEqual(ALL);
  });

  it("collapses to the one depot a fixed cart may use", () => {
    expect(returnWarehouseOptions({ kind: "fixed", ...A }, ALL)).toEqual([ALL[0]]);
  });

  it("offers only the depots a restricted cart can reach", () => {
    expect(returnWarehouseOptions({ kind: "restricted", options: [A, B] }, ALL)).toEqual([ALL[0], ALL[1]]);
  });

  it("names the depot from the hire when the warehouse list does not carry it", () => {
    // Inactive, or simply not loaded yet. An empty picker would hide a destination that is valid.
    expect(returnWarehouseOptions({ kind: "fixed", ...A }, [])).toEqual([{ value: A.warehouseId, label: A.warehouseName }]);
  });
});

describe("effectiveReturnWarehouse", () => {
  it("resolves an unresolved depot to NO destination, whatever was picked before", () => {
    // The bug exactly: a warehouse chosen while the cart held only company stock stayed selected once
    // a depot-less hire went in, and rode to the server as a real answer.
    expect(effectiveReturnWarehouse({ kind: "unknown" }, "wa")).toBe("");
    expect(effectiveReturnWarehouse({ kind: "unknown" }, "")).toBe("");
  });

  it("is the hire's own depot when the cart fixes it, ignoring any earlier pick", () => {
    expect(effectiveReturnWarehouse({ kind: "fixed", ...A }, "wc")).toBe(A.warehouseId);
  });

  it("keeps a restricted pick only while the cart still permits it", () => {
    const depot = { kind: "restricted" as const, options: [A, B] };
    expect(effectiveReturnWarehouse(depot, B.warehouseId)).toBe(B.warehouseId);
    expect(effectiveReturnWarehouse(depot, "wc")).toBe("");
  });

  it("leaves a company-stock cart with whatever the engineer chose", () => {
    expect(effectiveReturnWarehouse({ kind: "free" }, "wc")).toBe("wc");
  });

  it("never resolves to a warehouse the picker would not offer", () => {
    // The two must agree, or the form can hold a destination with no way to see or change it.
    for (const depot of [
      { kind: "unknown" } as const,
      { kind: "fixed" as const, ...A },
      { kind: "restricted" as const, options: [A, B] },
    ]) {
      const offered = returnWarehouseOptions(depot, ALL).map((o) => o.value);
      for (const picked of ["wa", "wb", "wc", ""]) {
        const chosen = effectiveReturnWarehouse(depot, picked);
        if (chosen) expect(offered).toContain(chosen);
      }
    }
  });
});
