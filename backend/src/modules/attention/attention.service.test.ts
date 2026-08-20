import { beforeEach, describe, expect, it, vi } from "vitest";

// The catalog is replaced with a small fixture so these tests pin the SERVICE contract — permission
// filtering, source selection, zero-suppression, nav rollup, failure isolation and caching — without
// touching a database. Catalog integrity is covered separately in attention.registry.test.ts.
vi.mock("#modules/settings/settings.service.js", () => ({ getCompanyTimezone: vi.fn(async () => "Europe/London") }));

// vi.mock factories are hoisted above every import, so the spies they reference must be created in a
// hoisted block too (a plain `const` above would still be in the temporal dead zone at factory time).
const { runPo, runJobs, runInv, runWh, runCust, findCodeById } = vi.hoisted(() => ({
  runPo: vi.fn(),
  runJobs: vi.fn(),
  runInv: vi.fn(),
  runWh: vi.fn(),
  runCust: vi.fn(),
  findCodeById: vi.fn(),
}));

vi.mock("#modules/warehouse/warehouse.repository.js", () => ({ findCodeById }));

vi.mock("./attention.registry.js", () => ({
  ATTENTION_NAV: {
    purchaseOrders: "/dashboard/purchase-orders",
    jobs: "/dashboard/jobs",
    inventory: "/dashboard/inventory",
    warehouses: "/dashboard/warehouses",
    customers: "/dashboard/customers",
  },
  ATTENTION_ENTITY_SOURCES: [
    { id: "wh_split", dimension: "warehouse", keys: ["wh.issue", "wh.van"], run: runWh },
    { id: "cust_split", dimension: "customer", keys: ["cust.requests"], run: runCust },
  ],
  ATTENTION_ITEMS: [
    { key: "po.approve", label: "POs to approve", perms: ["purchase_orders.approve"], tone: "attention", nav: "/dashboard/purchase-orders", href: "/po?a" },
    { key: "po.overdue", label: "Deliveries overdue", perms: ["purchase_orders.view"], tone: "critical", nav: "/dashboard/purchase-orders", href: "/po?o" },
    // Mirrors the real wh.goods_in_waiting: gated on a RECEIVING permission but landing on the
    // Purchase Orders module, which is behind a different grant.
    { key: "po.receive", label: "To receive", perms: ["goods_in.create"], tone: "info", nav: "/dashboard/purchase-orders", href: "/po?r", hrefPerms: ["purchase_orders.view"] },
    // Gated on the two send-side permissions — this is the item the PM-addressing test needs. The
    // fixture source never returns a count for it, so zero-suppression keeps the other totals intact.
    { key: "po.send", label: "To send", perms: ["purchase_orders.send", "purchase_orders.assign_pm"], tone: "attention", nav: "/dashboard/purchase-orders", href: "/po?s" },
    { key: "jobs.rejected", label: "Rejected", perms: ["jobs.assign"], tone: "critical", nav: "/dashboard/jobs", href: "/jobs?x" },
    { key: "inv.reorder", label: "Reorder", perms: ["inventory.view"], tone: "attention", nav: "/dashboard/inventory", href: "/inv" },
    // The urgent slice of inv.reorder — its rows are already inside that count.
    { key: "inv.critical", label: "Critical", perms: ["inventory.view"], tone: "critical", nav: "/dashboard/inventory", href: "/inv?c=1", subsetOf: "inv.reorder" },
    // A subset gated DIFFERENTLY from its parent — the real pair is "Deliveries overdue"
    // (purchase_orders.view) inside "Deliveries to receive" (goods_in.create), which a project
    // manager sees only half of.
    { key: "po.overdue_sub", label: "Overdue", perms: ["purchase_orders.view"], tone: "critical", nav: "/dashboard/purchase-orders", href: "/po?od", subsetOf: "po.receive" },
    // The link-less shapes: an aggregate with a warehouse tab behind it, one with nothing at all.
    { key: "wh.issue", label: "Kit to issue", perms: ["goods_management.issue"], tone: "attention", nav: "/dashboard/warehouses", warehouseQuery: "tab=goods" },
    { key: "wh.van", label: "Field requests", perms: ["van_stock_request.review"], tone: "info", nav: "/dashboard/warehouses", warehouseQuery: "tab=van" },
    { key: "cust.requests", label: "Stock requests", perms: ["stock_requests.approve"], tone: "critical", nav: "/dashboard/customers" },
  ],
  ATTENTION_SOURCES: [
    { id: "purchase_orders", keys: ["po.approve", "po.overdue", "po.receive", "po.send", "po.overdue_sub"], run: runPo },
    { id: "jobs", keys: ["jobs.rejected"], run: runJobs },
    { id: "inventory", keys: ["inv.reorder", "inv.critical"], run: runInv },
    { id: "warehouses", keys: ["wh.issue", "wh.van"], run: vi.fn(async () => ({ "wh.issue": 7, "wh.van": 2 })) },
    { id: "customers", keys: ["cust.requests"], run: vi.fn(async () => ({ "cust.requests": 3 })) },
  ],
}));

import { getAttention, getEntityAttention, invalidateAttention } from "./attention.service.js";
import type { Principal } from "../../types/principal.js";

const staff = (permissions: string[], assignedWarehouseIds: string[] | null = null, id = "u1"): Principal =>
  ({ type: "user", id, email: "u@x.com", permissions, assignedWarehouseIds }) as unknown as Principal;
const admin: Principal = { type: "admin", id: "a1", email: "a@x.com", name: "A" } as unknown as Principal;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAttention();
  runPo.mockResolvedValue({ "po.approve": 2, "po.overdue": 1, "po.receive": 5 });
  runJobs.mockResolvedValue({ "jobs.rejected": 3 });
  runInv.mockResolvedValue({ "inv.reorder": 4 });
});

describe("getAttention — permission filtering", () => {
  it("returns only the keys the actor may act on, and runs only the sources behind them", async () => {
    // A receiver holds ONE action permission — and no *.view anywhere.
    const res = await getAttention(staff(["goods_in.create"]));
    expect(res.items.map((i) => i.key)).toEqual(["po.receive"]);
    expect(runPo).toHaveBeenCalledTimes(1);
    // Jobs + inventory produce nothing this actor can see → those queries never run at all.
    expect(runJobs).not.toHaveBeenCalled();
    expect(runInv).not.toHaveBeenCalled();
  });

  it("never leaks a key the actor lacks, even when its source produced the number", async () => {
    // The PO source computes all three counts in one round trip; only the permitted one is emitted.
    const res = await getAttention(staff(["goods_in.create"]));
    expect(res.items.find((i) => i.key === "po.approve")).toBeUndefined();
    expect(res.items.find((i) => i.key === "po.overdue")).toBeUndefined();
    expect(res.total).toBe(5);
  });

  it("gives the super-admin everything", async () => {
    const res = await getAttention(admin);
    expect(res.items.map((i) => i.key).sort()).toEqual([
      "cust.requests", "inv.reorder", "jobs.rejected", "po.approve", "po.overdue", "po.receive", "wh.issue", "wh.van",
    ]);
    expect(res.total).toBe(27);
  });

  it("a user with no attention permission gets an empty payload and runs NO query", async () => {
    const res = await getAttention(staff(["suppliers.view"]));
    expect(res.items).toEqual([]);
    expect(res.byNav).toEqual({});
    expect(res.total).toBe(0);
    expect(runPo).not.toHaveBeenCalled();
    expect(runJobs).not.toHaveBeenCalled();
    expect(runInv).not.toHaveBeenCalled();
  });
});

describe("getAttention — zero suppression + nav rollup", () => {
  it("omits zero counts — a badge never renders a 0", async () => {
    runPo.mockResolvedValue({ "po.approve": 0, "po.overdue": 0, "po.receive": 0 });
    const res = await getAttention(staff(["purchase_orders.approve", "purchase_orders.view"]));
    expect(res.items).toEqual([]);
    expect(res.byNav["/dashboard/purchase-orders"]).toBeUndefined();
  });

  it("rolls a sidebar row up to the SUM of its items and the MOST SEVERE tone", async () => {
    const res = await getAttention(admin);
    // 2 approve + 1 overdue + 5 receive = 8, and one of them is critical.
    expect(res.byNav["/dashboard/purchase-orders"]).toEqual({ count: 8, tone: "critical" });
    expect(res.byNav["/dashboard/jobs"]).toEqual({ count: 3, tone: "critical" });
    expect(res.byNav["/dashboard/inventory"]).toEqual({ count: 4, tone: "attention" });
  });

  // A SUBSET's rows are already inside its parent's count. Adding both reports more work than exists —
  // and this pair is exactly nested by construction (criticalCount is count's rows, filtered), so the
  // inflation would be guaranteed rather than occasional.
  it("counts a subset's rows once, while still letting it set the row's tone", async () => {
    runInv.mockResolvedValue({ "inv.reorder": 4, "inv.critical": 1 });
    const res = await getAttention(admin);
    // 4, not 5 — but RED, because one of those four is critical.
    expect(res.byNav["/dashboard/inventory"]).toEqual({ count: 4, tone: "critical" });
    // The chip itself still shows its own number; only the rollup treats it as contained.
    expect(res.items.find((i) => i.key === "inv.critical")?.count).toBe(1);
    // 27, not 28: the whole payload's total excludes the contained key as well.
    expect(res.total).toBe(27);
  });

  // A subset stands down ONLY when its parent is permitted for THIS actor. The two can be gated
  // differently — the live pair is "Deliveries overdue" (purchase_orders.view) inside "Deliveries to
  // receive" (goods_in.create) — so an actor holding just the child's permission sees no parent, and
  // subtracting it anyway would report LESS work than exists.
  describe("a subset gated differently from its parent", () => {
    it("is absorbed when the actor can see the parent too", async () => {
      runPo.mockResolvedValue({ "po.receive": 4, "po.overdue_sub": 1 });
      const res = await getAttention(admin);
      // 4, not 5 — and red, because the contained rows are the overdue ones.
      expect(res.byNav["/dashboard/purchase-orders"]).toMatchObject({ count: 4, tone: "critical" });
    });

    it("counts for itself when the actor cannot see the parent", async () => {
      runPo.mockResolvedValue({ "po.receive": 4, "po.overdue_sub": 1 });
      // Holds the child's permission and NOT the parent's — a project manager's shape.
      const pm = { type: "user", id: "u9", email: "pm@x.co", permissions: ["purchase_orders.view"] } as unknown as Principal;
      const res = await getAttention(pm);
      expect(res.items.map((i) => i.key)).toEqual(["po.overdue_sub"]);
      // 1, not 0: this actor has one thing to do and the badge has to say so.
      expect(res.byNav["/dashboard/purchase-orders"]).toEqual({ count: 1, tone: "critical" });
    });
  });

  // The client's own header total has to skip it too, so `subsetOf` travels with the item.
  it("tells the client which items are contained in another", async () => {
    runInv.mockResolvedValue({ "inv.reorder": 4, "inv.critical": 1 });
    const res = await getAttention(admin);
    expect(res.items.find((i) => i.key === "inv.critical")?.subsetOf).toBe("inv.reorder");
    expect(res.items.find((i) => i.key === "inv.reorder")?.subsetOf).toBeUndefined();
  });

  // Guards the zero-badge promise: if a parent empties but its subset does not, the row must not
  // render a badge of 0 (nor a count that contradicts the chip beside it).
  it("never renders a row whose only remaining work is a subset", async () => {
    runInv.mockResolvedValue({ "inv.reorder": 0, "inv.critical": 1 });
    const res = await getAttention(admin);
    expect(res.byNav["/dashboard/inventory"]).toBeUndefined();
  });

  it("keeps a row's tone calm when nothing critical is in it", async () => {
    runPo.mockResolvedValue({ "po.approve": 2, "po.overdue": 0, "po.receive": 0 });
    const res = await getAttention(admin);
    expect(res.byNav["/dashboard/purchase-orders"]).toEqual({ count: 2, tone: "attention" });
  });

  it("sorts items worst-first", async () => {
    const res = await getAttention(admin);
    expect(res.items[0].tone).toBe("critical");
    expect(res.items.at(-1)!.tone).toBe("info");
  });
});

describe("getAttention — failure isolation", () => {
  it("a failing source reports its id and drops its keys — it never throws or zeroes the rest", async () => {
    runPo.mockRejectedValue(new Error("db down"));
    const res = await getAttention(admin);
    expect(res.errors).toEqual(["purchase_orders"]);
    expect(res.items.map((i) => i.key)).toEqual(expect.arrayContaining(["inv.reorder", "jobs.rejected"]));
    // The failed keys are ABSENT, not 0 — the UI can tell "unknown" from "nothing to do".
    expect(res.items.find((i) => i.key === "po.approve")).toBeUndefined();
    expect(res.total).toBe(19); // 27 minus the PO source's 8
  });
});

describe("getAttention — scoping + caching", () => {
  it("passes the actor's warehouse scope to every source; undefined for an unrestricted actor", async () => {
    await getAttention(staff(["purchase_orders.approve"], ["w1", "w2"]));
    expect(runPo.mock.calls[0][0]).toMatchObject({ scope: ["w1", "w2"] });

    invalidateAttention();
    vi.clearAllMocks();
    runPo.mockResolvedValue({ "po.approve": 1 });
    await getAttention(admin);
    expect(runPo.mock.calls[0][0].scope).toBeUndefined();
  });

  it("addresses the PM queue to the actor unless they can reassign PMs", async () => {
    await getAttention(staff(["purchase_orders.send"], null, "pm-1"));
    expect(runPo.mock.calls[0][0]).toMatchObject({ userId: "pm-1" });

    invalidateAttention();
    vi.clearAllMocks();
    runPo.mockResolvedValue({ "po.approve": 1 });
    await getAttention(staff(["purchase_orders.send", "purchase_orders.assign_pm"], null, "pm-1"));
    expect(runPo.mock.calls[0][0].userId).toBeUndefined();
  });

  it("serves the burst cache on a repeat read, and `fresh` bypasses it", async () => {
    await getAttention(admin);
    await getAttention(admin);
    expect(runPo).toHaveBeenCalledTimes(1); // second read came from cache

    await getAttention(admin, { fresh: true });
    expect(runPo).toHaveBeenCalledTimes(2); // a socket-driven refetch is never served stale
  });

  it("never serves one actor's numbers to another, or one warehouse scope to a different one", async () => {
    await getAttention(staff(["purchase_orders.approve"], ["w1"], "u1"));
    await getAttention(staff(["purchase_orders.approve"], ["w1"], "u2")); // different user
    await getAttention(staff(["purchase_orders.approve"], ["w2"], "u1")); // same user, other scope
    expect(runPo).toHaveBeenCalledTimes(3);
  });
});

// Six warehouse-floor queues have no cross-warehouse screen, so the catalog gives them no href — they
// used to point at the bare warehouse LIST, which navigated without showing a single counted row (and
// on the warehouses page itself, reloaded the page the user was already on).
//
// The one case where the ambiguity genuinely isn't there is an actor who can reach exactly ONE
// warehouse: the aggregate and that warehouse are the same set of rows, so it becomes a real link.
describe("getAttention — the aggregates that have nowhere to go", () => {
  it("deep-links a single-warehouse actor straight to the tab that holds the work", async () => {
    findCodeById.mockResolvedValue("WH-A");
    const res = await getAttention(staff(["goods_management.issue", "van_stock_request.review", "warehouse.view"], ["w1"]));
    expect(res.items.find((i) => i.key === "wh.issue")?.href).toBe("/dashboard/warehouses/WH-A?tab=goods");
    expect(res.items.find((i) => i.key === "wh.van")?.href).toBe("/dashboard/warehouses/WH-A?tab=van");
    expect(findCodeById).toHaveBeenCalledTimes(1); // one lookup for the whole payload, not one per item
    expect(findCodeById).toHaveBeenCalledWith("w1");
  });

  // Being able to WORK a queue and being able to open the screen that lists it are separate grants.
  // Floor staff hold goods_management.issue without warehouse.view all the time, and the built link
  // would have dropped them on the detail page's "no access" screen.
  it("withholds the warehouse deep link from an actor who cannot open a warehouse page", async () => {
    findCodeById.mockResolvedValue("WH-A");
    const res = await getAttention(staff(["goods_management.issue"], ["w1"]));
    const item = res.items.find((i) => i.key === "wh.issue");
    expect(item?.href).toBeUndefined();
    expect(item?.count).toBe(7); // the COUNT stays — it is still their work, it just isn't a link
  });

  it("leaves a MULTI-warehouse actor with a plain number — there is no single destination", async () => {
    const res = await getAttention(staff(["goods_management.issue", "warehouse.view"], ["w1", "w2"]));
    expect(res.items.find((i) => i.key === "wh.issue")?.href).toBeUndefined();
    expect(findCodeById).not.toHaveBeenCalled();
  });

  it("leaves an UNSCOPED actor with a plain number too, and pays for no lookup", async () => {
    const res = await getAttention(admin);
    expect(res.items.find((i) => i.key === "wh.issue")?.href).toBeUndefined();
    expect(res.items.find((i) => i.key === "cust.requests")?.href).toBeUndefined();
    expect(findCodeById).not.toHaveBeenCalled();
  });

  // A queue with no warehouse behind it (the customer ones) must never pick up a warehouse link just
  // because the actor happens to be scoped to one.
  it("never invents a warehouse link for a queue that isn't warehouse work", async () => {
    findCodeById.mockResolvedValue("WH-A");
    const res = await getAttention(staff(["goods_management.issue", "stock_requests.approve", "warehouse.view"], ["w1"]));
    expect(res.items.find((i) => i.key === "wh.issue")?.href).toBe("/dashboard/warehouses/WH-A?tab=goods");
    expect(res.items.find((i) => i.key === "cust.requests")?.href).toBeUndefined();
  });

  // A deleted or unreadable warehouse must degrade to "no link", never to a 500 on the endpoint the
  // whole shell fetches on every page load.
  it("falls back to a plain number when the warehouse code can't be read", async () => {
    findCodeById.mockRejectedValue(new Error("gone"));
    const res = await getAttention(staff(["goods_management.issue", "warehouse.view"], ["w1"]));
    expect(res.items.find((i) => i.key === "wh.issue")?.href).toBeUndefined();
    expect(res.errors).toEqual([]);
  });

  // The same rule for catalog hrefs that cross into another module (or need a `view` the actor's
  // action grant doesn't imply): show the number, withhold the link that would be refused.
  it("withholds a catalog href the actor's permissions cannot open, but keeps the count", async () => {
    const res = await getAttention(staff(["goods_in.create"]));
    const item = res.items.find((i) => i.key === "po.receive");
    expect(item?.count).toBeGreaterThan(0);
    expect(item?.href).toBeUndefined();
  });

  it("keeps the href once the actor can open the destination", async () => {
    const res = await getAttention(staff(["goods_in.create", "purchase_orders.view"]));
    expect(res.items.find((i) => i.key === "po.receive")?.href).toBe("/po?r");
  });

  it("does not hand the client the permission list each count is gated on", async () => {
    const res = await getAttention(admin);
    // `perms` is catalog wiring; the old build spread the whole meta object straight onto the payload.
    for (const item of res.items) expect(item).not.toHaveProperty("perms");
    for (const item of res.items) expect(item).not.toHaveProperty("hrefPerms");
    for (const item of res.items) expect(item).not.toHaveProperty("warehouseQuery");
  });
});

// The per-row counts on the Warehouses / Customers lists: the ONLY navigation the link-less
// aggregates have for an actor who can reach more than one entity.
describe("getEntityAttention", () => {
  beforeEach(() => {
    runWh.mockResolvedValue({
      w1: { "wh.issue": 4, "wh.van": 1 },
      w2: { "wh.issue": 3 },
    });
    runCust.mockResolvedValue({ c1: { "cust.requests": 2 } });
  });

  it("rolls each entity up to a total, its worst tone, and the per-key split", async () => {
    const rows = await getEntityAttention(admin, "warehouse");
    // wh.issue is `attention`, wh.van is `info` → the row takes the more severe of the two.
    expect(rows.w1).toEqual({ count: 5, tone: "attention", keys: { "wh.issue": 4, "wh.van": 1 } });
    expect(rows.w2).toEqual({ count: 3, tone: "attention", keys: { "wh.issue": 3 } });
  });

  it("runs only the sources for the dimension asked for", async () => {
    await getEntityAttention(admin, "customer");
    expect(runCust).toHaveBeenCalledTimes(1);
    expect(runWh).not.toHaveBeenCalled();
  });

  // Same gate as the badge path: a source may produce several keys under different permissions.
  it("drops keys the actor may not see, and returns nothing when they may see none", async () => {
    const rows = await getEntityAttention(staff(["goods_management.issue"]), "warehouse");
    expect(rows.w1).toEqual({ count: 4, tone: "attention", keys: { "wh.issue": 4 } });

    invalidateAttention();
    const none = await getEntityAttention(staff(["suppliers.view"]), "warehouse");
    expect(none).toEqual({});
    expect(runWh).toHaveBeenCalledTimes(1); // the permission-less actor ran no query at all
  });

  it("passes the actor's warehouse scope through, so a row for a warehouse they can't reach never exists", async () => {
    await getEntityAttention(staff(["goods_management.issue"], ["w1"]), "warehouse");
    expect(runWh.mock.calls[0][0]).toMatchObject({ scope: ["w1"] });
  });

  // A whole list of rows silently losing its counts is worse than one row missing one queue, so a
  // broken source degrades the same way the badge path's does.
  it("a failing source drops its keys instead of failing the list", async () => {
    runWh.mockRejectedValue(new Error("db down"));
    await expect(getEntityAttention(admin, "warehouse")).resolves.toEqual({});
  });

  it("caches per actor, scope AND dimension; `fresh` bypasses it", async () => {
    await getEntityAttention(admin, "warehouse");
    await getEntityAttention(admin, "warehouse");
    expect(runWh).toHaveBeenCalledTimes(1);

    await getEntityAttention(admin, "customer");
    expect(runCust).toHaveBeenCalledTimes(1); // a different dimension is not the same cache entry

    await getEntityAttention(admin, "warehouse", { fresh: true });
    expect(runWh).toHaveBeenCalledTimes(2);
  });
});
