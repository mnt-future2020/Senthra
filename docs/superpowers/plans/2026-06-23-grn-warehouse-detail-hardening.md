# GRN Terminology + Warehouse Detail Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **STATUS: PLAN ONLY. Do not implement, migrate, or commit until the user approves.**

**Goal:** Rebrand "Goods In" → "GRN (Goods Receipt Note)" as a *presentation-only* change, and turn Warehouse Detail into the warehouse-scoped operational hub, while keeping company-owned (IRM/GRN) and customer-owned (consignment) stock completely separate and introducing zero regressions.

**Architecture:** The backend already models receiving as `GoodsReceipt` with `GRN-` codes and a "Goods Receipt Note" document name. Only *labels* and a few *persisted identifiers* still read "goods in". This plan treats the rename as a label change (identifiers are contracts and stay untouched), and reuses the existing, already-warehouse-scoped GRN list/inventory machinery to enrich Warehouse Detail rather than building anything new.

**Tech Stack:** Express 5 + Prisma (MongoDB), pnpm, Node ≥20 (backend); Next.js 16 App Router + React 19 + Tailwind v4 (frontend). Backend tests run on vitest (`pnpm test`).

## Global Constraints

- **No database migrations, no new tables/columns, no schema changes** unless a phase explicitly proves one is unavoidable (none are).
- **Do NOT rename persisted identifiers.** These are contracts touching stored data and stay exactly as-is:
  - Permission keys `goods_in.view|create|edit|delete|complete|cancel` (stored in `Role.permissions`).
  - Audit `action` strings `goods_in.*` and `targetType: "goods_receipt"` (stored in historical audit rows).
  - Inventory ledger `sourceType: "goods_receipt"` and `type: "goods_in"` (stored in `InventoryTransaction`).
  - HTTP route base `/goods-in` and frontend route base `/dashboard/goods-in`.
  - GRN code prefix `GRN-` (already correct).
- **Customer-owned and company-owned stock must never be mixed** in any query, endpoint, list, or shared component. The ownership boundary is enforced by physically separate tables (`CustomerStock*` vs `IrmItem`/`InventoryBalance`/`GoodsReceipt`); the UI must mirror that separation — no merged "incoming" list.
- **Warehouse scoping stays backend-enforced** via `src/lib/warehouse-access.ts` (`warehouseScopeFilter` / `assertWarehouseAccess`). The frontend principal carries no `assignedWarehouseIds`; do not add frontend scope logic that assumes it.
- **ESM/NodeNext**: relative imports include `.js`; cross-module imports use `#modules/<domain>/...`.
- **Customers never see pricing** — no monetary field may enter any customer-facing shape.
- **Git**: no branches/commits/pushes without explicit user request.

---

## Architecture Analysis (answers to the 6 investigation questions)

### Current state (verified)

| Concern | Where it lives today |
|---|---|
| Company receiving (GRN) | Global module `/dashboard/goods-in` → `GoodsReceiptsView`. Backend `/goods-in`, model `GoodsReceipt`, code `GRN-####`. List endpoint already supports `?warehouse=<id>` and stacks `warehouseScopeFilter(actor)`. |
| Customer consignment receiving | Warehouse Detail **"Incoming stock"** tab (`stock_requests.view`). Reads `GET /warehouses/:id/pending-stock` → `CustomerStockWarehouseAssignment`. Receiving creates `CustomerStockEntry`. **No global page.** |
| Warehouse holdings | Warehouse Detail **"Inventory"** tab with an inner **company (IRM)** vs **customer** pool toggle. |
| Ownership separation | Schema-level: company stock = `IrmItem → InventoryBalance → InventoryTransaction`; customer stock = `CustomerStockRequest → ...Assignment → CustomerStockEntry`. No shared stock table, no `customerId` on inventory tables. Watertight. |
| Warehouse-manager scoping | `Role.isWarehouseScoped` + `UserWarehouseAssignment`; loaded once in `requireAuth`, enforced in every warehouse-bound service. Frontend nav is permission-gated only; global lists auto-scope server-side. |

### Q1 — Incoming Stock tab vs dedicated GRN tab vs both → **Recommendation: dedicated GRN tab + rename the existing tab; never merge.**

Three options compared:

| Option | Verdict | Why |
|---|---|---|
| **A. One "Incoming" tab, customer vs GRN inside it** | ❌ Reject | Forces customer-owned and company-owned data into one screen/component. Tempts a shared list/query and a shared "incoming" abstraction — the exact accidental-coupling the ownership boundary forbids. The two pipelines have different sources (PO vs stock request), different permissions (`goods_in.*` vs `stock_requests.*`), different receive semantics, and different downstream stores. Co-locating them is cognitive and structural risk for no gain. |
| **B. Dedicated GRN tab, customer receiving stays its own tab** | ✅ **Recommend** | Mirrors the schema's hard separation in the UI. Each tab owns one pipeline, one permission, one service. The GRN tab reuses the already-warehouse-scoped GRN list with zero backend change. Symmetric with the Inventory tab's two *separately-rendered* pools. |
| **C. Keep both (global GRN module + warehouse GRN tab)** | ✅ Adopt *alongside* B | Keep the global `/dashboard/goods-in` module (needed by unscoped procurement/admin roles and for cross-warehouse search). Add the warehouse-scoped GRN tab as a *filtered view of the same data/component*, not a fork. One component, two mount points — no duplication. |

**Net recommendation:** Warehouse Detail gets a **dedicated, read-focused GRN tab** (list scoped to the warehouse, deep-links into the existing GRN detail/create flow). The existing customer "Incoming stock" tab is **renamed "Customer incoming"** to end the naming ambiguity. The two never share a list or a query. The global GRN module stays for unscoped roles. This is the cleanest production-grade ERP shape: the UI separation is isomorphic to the data separation.

### Q2 — Warehouse Manager experience

- **Visible:** Their assigned warehouses (Warehouse list auto-scoped server-side), and inside each: Overview, GRN (their warehouse's receipts), Customer incoming, Inventory (both pools), optionally Goods Out, Transactions, Audit. Global GRN/Inventory/Goods-Out nav items remain visible *and already return only their warehouses' rows* because every list service applies `warehouseScopeFilter(actor)`.
- **Hidden:** Anything their role lacks permission for (nav is permission-gated). Nothing extra needs hiding — and importantly, **do not** try to hide global modules based on warehouse-scope, because the frontend principal deliberately does not carry `assignedWarehouseIds`. Adding that would be a new data exposure + a regression surface. Keep scoping server-side.
- **Should they see a global GRN module?** Yes — keep it. It is safe (auto-scoped) and is the right surface for cross-warehouse search. The warehouse-detail GRN tab is the *warehouse-centric* entry point, not a replacement.
- **Should they work entirely inside Warehouse Detail?** Make Warehouse Detail their **primary hub** (richest in-context workflow), but do not force it. The global modules stay as a secondary, auto-scoped path. This avoids any change to nav gating and keeps the blast radius tiny.
- **Optional nicety (Phase 4, deferrable):** a default landing redirect for pure warehouse-scoped users into their (single) warehouse. Requires surfacing the user's warehouses to the frontend — treat as a separate, explicitly-scoped enhancement, not part of the rename.

### Q3 — Ownership boundaries and every accidental-coupling risk

Company pipeline: `PurchaseOrder → GRN (GoodsReceipt) → InventoryBalance/InventoryTransaction (IRM)`.
Customer pipeline: `CustomerStockRequest → CustomerStockWarehouseAssignment → CustomerStockEntry`.

Places coupling could accidentally be introduced (guard these in review):

1. **A merged "Incoming" list** (Option A above) — rejected by design. The GRN tab must call `grnService.listGoodsReceipts({ warehouse })` only; the Customer incoming tab must call `customerService.getPendingStockForWarehouse()` only. No shared fetch.
2. **Shared `Category` table** — used by both `IrmItem` and `CustomerStockEntry`. Safe because customer queries always filter by `customerId`; never add an IRM-category filter to a customer query or vice-versa.
3. **Shared `Warehouse` table** — both reference it; safe because there is no stock-bearing column on `Warehouse`. Keep it that way.
4. **The Inventory tab's pool toggle** — the one screen where both pools appear. They must remain two separate fetches/renders behind the toggle (already the case). Never compute a combined total across pools.
5. **A future warehouse "Transactions" tab** — the placeholder copy mentions "goods in, goods out, transfers". If built, it must read the company `InventoryTransaction` ledger only; customer movements are not in that ledger and must not be union-ed in.
6. **The GRN tab's "New" button** — GRN creation is PO-driven (company-only by construction). Do not let a warehouse-detail create flow accept customer context.
7. **Customer-stock feature seam** (`customer.stock.service.ts`, `FEATURE_CUSTOMER_STOCK`) — when wired, keep it customer-scoped; it must never read `InventoryBalance`.

The boundary is currently watertight; the risk is entirely in the *new UI* tempting a shared abstraction. The plan keeps the components separate to preserve it.

### Q4 — Cleanest Warehouse Detail layout (no duplicate tabs/nav)

Tab order by material flow (inbound → holdings → outbound → records):

```
Overview │ GRN │ Customer incoming │ Inventory │ [Goods out] │ Transactions │ Audit
          (company)   (customer)     (both pools, toggled)  (optional)
```

- `GRN` — perm `goods_in.view`; warehouse-scoped GRN list (reuses `GoodsReceiptsView`).
- `Customer incoming` — perm `stock_requests.view`; the existing tab, renamed.
- `Inventory` — unchanged (company/customer pools).
- `Goods out` — optional (Phase 3), perm `goods_out.view`.
- One tab per pipeline; no tab shows two ownership types; no nav item duplicated (global modules stay in the sidebar unchanged).

### Q5 — Regression surface

| Area | Impact | Mitigation |
|---|---|---|
| Purchase Orders | None — identifiers and `applyGoodsReceipt` seam untouched. | Don't touch PO module. |
| Inventory | None — `sourceType:"goods_receipt"`, `type:"goods_in"` unchanged; ledger reads intact. | Don't touch ledger strings. |
| Goods Out | None — independent of GRN; only a *new optional tab* reusing its existing view. | Additive only. |
| Customer Stock / Customer Portal | None — separate tables/endpoints; pricing rule preserved. | Don't touch customer queries; only relabel the tab. |
| Warehouse-manager assignment | None — no change to `isWarehouseScoped`, `UserWarehouseAssignment`, or `requireAuth`. | Keep scoping server-side. |
| Audit trail | **Continuity risk if action strings change** → keep `goods_in.*`/`goods_receipt`. Only the *display label* changes. | Phase 0 changes `auditDisplay.ts` labels, not action keys. |
| Warehouse access restrictions | None — `warehouse-access.ts` untouched; GRN tab inherits server-side scoping. | Verify scoped user sees only their warehouse's GRNs. |

### Q6 — Reuse map

- Reuse `GoodsReceiptsView` for the GRN tab (add one optional prop). 
- Reuse the backend `warehouse` list filter (already exists) — no new endpoint.
- Reuse the `InventoryView` pool pattern as the visual precedent for separation.
- Reuse the existing tab framework in `WarehouseDetail.tsx` (array config + `?tab=` routing).
- Reuse `permissions.ts` group `label`/`description` fields for the rename (display strings, safe to edit).

---

## File Structure

**Phase 0 — Terminology (labels only):**
- Modify: `frontend/src/components/dashboard/shell/Sidebar.tsx` (nav label).
- Modify: `frontend/src/components/dashboard/goods-in/GoodsReceiptsView.tsx` (page title/copy).
- Modify: `frontend/src/components/dashboard/goods-in/GoodsReceiptDetail.tsx`, `GoodsReceiptForm.tsx`, `grnStatus.tsx` (visible headings/copy).
- Modify: `frontend/src/components/dashboard/audit/auditDisplay.ts` (action → human label; keep keys).
- Modify: `backend/src/modules/role/permissions.ts` (group `label`/`description` only; keys unchanged).
- Optional copy: `frontend/src/components/dashboard/purchase-orders/PurchaseOrdersView.tsx:212`, supplier/warehouse helper text mentioning "Goods In".

**Phase 1 — Rename customer "Incoming stock" tab:**
- Modify: `frontend/src/components/dashboard/warehouses/WarehouseDetail.tsx` (tab label + leading comment; component logic unchanged).

**Phase 2 — Warehouse-scoped GRN tab:**
- Modify: `frontend/src/components/dashboard/goods-in/GoodsReceiptsView.tsx` (add optional `warehouseId?: string` prop → list param + hide warehouse column/filter; default behavior unchanged when prop absent).
- Modify: `frontend/src/components/dashboard/warehouses/WarehouseDetail.tsx` (add `grn` tab gated by `goods_in.view`, mount `<GoodsReceiptsView warehouseId={w.id} />`).

**Phase 3 (optional) — Goods Out tab:**
- Modify: `WarehouseDetail.tsx` + the existing Goods Out list view (add optional `warehouseId` prop if not present; verify backend `goods-out` list supports a warehouse filter before relying on it).

**Phase 4 (optional/deferred) — warehouse-manager landing:** separate spec; out of scope here.

---

## Task Breakdown

### Phase 0 — Terminology rebrand (presentation only)

**Goal:** Everywhere a human reads "Goods In", it reads "GRN (Goods Receipt Note)" / "Goods Receipts". No identifier, key, route, or stored string changes.

**Files affected:** Sidebar, GRN view/detail/form/status components, `auditDisplay.ts`, `permissions.ts` (label/description fields only), optional helper-copy spots.

**Dependencies:** None. Can ship independently.

**Risks:**
- *Risk:* an over-eager find-replace also changes `goods_in.*` keys / `goods_receipt` strings / route paths. → **Mitigation:** edit only string *literals shown to users*; never touch `key:`, `action:` (audit), `targetType:`, `sourceType:`, route paths, or permission keys. Grep after editing to prove identifiers are untouched.
- *Risk:* audit history rows look inconsistent. → They keep their stored `goods_in.*` action; only the rendered label changes, so old and new rows render identically. No data touched.

**Regression impact:** Cosmetic only. Permission checks, audit queries, ledger queries, routes all unchanged.

**Validation:**
- `cd frontend && pnpm lint && pnpm build`.
- `cd backend && pnpm typecheck && pnpm lint && pnpm test`.
- Grep proof that identifiers are intact:
  - `goods_in\.` count in `permissions.ts`, `goods-in.routes.ts`, `goods-in.service.ts` unchanged.
  - `sourceType: "goods_receipt"` and `type === "goods_in"` unchanged.
- Manual: sidebar shows "Goods Receipts (GRN)"; role editor shows the new group label; audit log renders GRN wording for a `goods_in.completed` row; permissions still gate the page.

Steps:
- [ ] **Step 0.1:** In `Sidebar.tsx`, change the nav `label` `"Goods In"` → `"Goods Receipts"` (keep `href: "/dashboard/goods-in"` and `perms: ["goods_in.view"]`).
- [ ] **Step 0.2:** In `GoodsReceiptsView.tsx` / `GoodsReceiptDetail.tsx` / `GoodsReceiptForm.tsx` / `grnStatus.tsx`, update visible titles/section headings/empty-state copy from "Goods In" to "Goods Receipt Note (GRN)" / "Goods Receipts". Leave service calls, routes, permission strings, and type names alone.
- [ ] **Step 0.3:** In `auditDisplay.ts`, ensure the `goods_in.*` action keys map to human labels using "GRN"/"Goods Receipt" wording. Do **not** change the action keys themselves.
- [ ] **Step 0.4:** In `permissions.ts`, change the `goods_in` group's `label` to "Goods Receipts (GRN)" and refine its `description`. Leave all six `key` values unchanged.
- [ ] **Step 0.5:** (Optional) Update incidental "Goods In" helper copy in PO/supplier/warehouse views.
- [ ] **Step 0.6:** Run the full validation block above; paste outputs.

### Phase 1 — Disambiguate the customer "Incoming stock" tab

**Goal:** Rename the warehouse-detail customer tab from "Incoming stock" to "Customer incoming" so it is unmistakably customer-owned (and won't be confused with the new GRN tab).

**Files affected:** `WarehouseDetail.tsx` (the `TABS` array label + the explanatory comment block at lines ~28–41). Component/query logic unchanged.

**Dependencies:** Best landed before Phase 2 so the two inbound tabs read clearly side by side.

**Risks:** Trivial. Only a label and a comment change; the tab still gates on `stock_requests.view` and still calls `getPendingStockForWarehouse`.

**Regression impact:** None. Empty-state copy already says "Customer stock assigned to this warehouse will appear here."

**Validation:** `pnpm lint && pnpm build`; manual check that the tab still loads customer pending stock and the Receive flow works.

Steps:
- [ ] **Step 1.1:** In `WarehouseDetail.tsx`, change the `incoming` tab `label` `"Incoming stock"` → `"Customer incoming"`. Keep `key: "incoming"`, `perm: "stock_requests.view"`.
- [ ] **Step 1.2:** Update the comment block to describe it as the *customer-consignment* receive worklist, and note the separate GRN tab handles company receiving.
- [ ] **Step 1.3:** Validate.

### Phase 2 — Warehouse-scoped GRN tab

**Goal:** Add a "GRN" tab to Warehouse Detail that lists that warehouse's goods receipts, reusing `GoodsReceiptsView`, with zero backend change.

**Files affected:** `GoodsReceiptsView.tsx` (add optional `warehouseId` prop), `WarehouseDetail.tsx` (new tab + mount).

**Dependencies:** Phase 0 (so labels are consistent). Backend: none — `listGoodsReceipts` already accepts `warehouse` and stacks server-side scoping.

**Interfaces:**
- Consumes: `grnService.listGoodsReceipts({ warehouse })` (existing), `useAuth().can("goods_in.view")`.
- Produces: `GoodsReceiptsView` gains optional prop `warehouseId?: string`. When set: pass `warehouse: warehouseId` into list params, hide the warehouse column and the warehouse filter control, and keep deep-links to `/dashboard/goods-in/[id]`. When absent: behavior is byte-for-byte the current global view.

**Risks:**
- *Risk:* embedded view's `router.push` to `/dashboard/goods-in/[id]` navigates away from the warehouse page. → Acceptable (matches existing global UX); optionally pass a `returnTo` later. Not a regression.
- *Risk:* the view currently builds list params *without* `warehouse`; adding the prop must be strictly additive so the global page is unaffected. → Guard with `warehouseId ? { warehouse: warehouseId } : {}` and default the prop to `undefined`.
- *Risk:* scoped user could see another warehouse's GRNs. → Backend `warehouseScopeFilter(actor)` already intersects; the `warehouse` param only narrows further. Verify in validation.

**Regression impact:** Global GRN module unchanged when the prop is absent. No backend, schema, permission, or audit change.

**Validation:**
- `cd frontend && pnpm lint && pnpm build`.
- Manual, as an unscoped admin: open Warehouse A → GRN tab shows only Warehouse A receipts; the global `/dashboard/goods-in` still shows all.
- Manual, as a warehouse-scoped manager assigned only Warehouse A: GRN tab shows A's receipts; attempting Warehouse B's URL is blocked server-side (existing behavior).
- Confirm the tab is hidden when the role lacks `goods_in.view`.

Steps:
- [ ] **Step 2.1:** Add `warehouseId?: string` to `GoodsReceiptsView` props; thread it into the list `params` (`warehouse: warehouseId`) and into the cache key path (already supported by `listCacheKey`).
- [ ] **Step 2.2:** When `warehouseId` is set, hide the warehouse column and any warehouse filter; keep status/search.
- [ ] **Step 2.3:** In `WarehouseDetail.tsx`, add `grn` to the `Tab` union and a `TABS` entry `{ key: "grn", label: "GRN", perm: "goods_in.view" }`, positioned before `Customer incoming`.
- [ ] **Step 2.4:** Render `{tab === "grn" && <GoodsReceiptsView warehouseId={w.id} />}`.
- [ ] **Step 2.5:** Validate (both roles).

### Phase 3 (optional) — Goods Out tab

**Goal:** Symmetric outbound tab in Warehouse Detail.

**Files affected:** `WarehouseDetail.tsx`; the Goods Out list view (add optional `warehouseId` prop).

**Dependencies:** Verify the backend `goods-out` list endpoint accepts a warehouse filter (the service already applies `warehouseScopeFilter`; confirm an explicit `warehouse` query param exists or add it the same way GRN does — that addition, if needed, is additive and migration-free).

**Risks:** If the Goods Out list has no warehouse param, a small additive backend change is required (mirror GRN's `warehouse` filter). Defer if not wanted now.

**Regression impact:** Additive; global Goods Out module unchanged when prop absent.

**Validation:** `pnpm lint && pnpm build` (frontend); `pnpm typecheck && pnpm test` (backend if touched); scoped/unscoped manual checks.

Steps:
- [ ] **Step 3.1:** Confirm/extend Goods Out list to accept `warehouse` filter.
- [ ] **Step 3.2:** Add optional `warehouseId` prop to the Goods Out view (additive).
- [ ] **Step 3.3:** Add `goods_out` tab gated by `goods_out.view`; mount scoped view.
- [ ] **Step 3.4:** Validate.

### Phase 4 (deferred) — Warehouse-manager landing/scope-aware nav

Out of scope for the rename. If pursued later, write a separate spec: it requires surfacing the user's assigned warehouses to the frontend principal (a new, deliberately-scoped data exposure) and a default-redirect for pure warehouse-scoped users. Do not bundle with Phases 0–3.

---

## Self-Review

- **Spec coverage:** Q1 (tab strategy) → Architecture Analysis + Phases 1–2. Q2 (manager UX) → Analysis Q2 + Phase 4 note. Q3 (ownership/coupling) → Analysis Q3 + Phase-2/3 separation rules. Q4 (layout) → Analysis Q4 + Phase 2. Q5 (regressions) → per-phase Regression sections + table. Q6 (reuse) → Reuse map + Phase 2 prop reuse. Q7 (phased plan w/ files/risks/deps/regression/validation) → every phase carries those headings. ✓
- **No identifier drift:** All persisted strings (`goods_in.*`, `goods_receipt`, `sourceType`, routes, code prefix) are explicitly frozen in Global Constraints and re-checked in Phase 0 validation. ✓
- **No migrations/tables:** Confirmed unnecessary — GRN list filter and customer endpoints already exist. ✓
- **Boundary preserved:** No phase introduces a shared customer/company query or component. ✓

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-06-23-grn-warehouse-detail-hardening.md`. **No code has been written and nothing will be until you approve.**
