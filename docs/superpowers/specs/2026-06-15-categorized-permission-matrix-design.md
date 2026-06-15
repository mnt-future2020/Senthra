# Categorized, scalable permission matrix — design

**Date:** 2026-06-15
**Status:** Approved (brainstorm)

## Problem

The role editor (`RoleForm`) and the read-only role page (`RoleDetail`) render the
RBAC catalog as a single flat list — one row per permission group. There are already
13 groups (6 of them customer-related), and inventory / jobs / warehouse modules are
still to ship. The flat list is already a long scroll and will not scale. The two
screens also duplicate near-identical matrix-rendering markup.

## Goal

Reorganize the matrix into collapsible **category** sections with search, granted-count
badges, per-category bulk actions, and visual nesting of customer sub-entities — and
share one component between the editor and the detail view. No change to permission
*logic* or the wire format beyond additive, presentational metadata.

## Approach

### 1. Backend — categories in the source of truth (`permissions.ts`)

`PERMISSION_GROUPS` stays the single source of truth. Extend `PermissionGroup` with:

- `category: string` — display category, e.g. `"Customers"`.
- `parent?: string` — module key of the parent group, for nesting. The 5 customer
  sub-entity groups (`customer_projects`, `customer_stock`, `customer_sites`,
  `customer_portal`, `stock_requests`) get `parent: "customers"`.

Add an exported ordered `PERMISSION_CATEGORIES: string[]` so category order is
server-controlled and stable. Groups whose `category` is unknown/missing fall back to
a trailing `"General"` bucket.

Category assignment:

| Category          | Modules                                                                   |
|-------------------|--------------------------------------------------------------------------|
| Access & Security | Users, Roles & permissions                                               |
| Customers         | Customers → Projects, Stock Catalogue, Sites, Portal Login, Stock Requests |
| Inventory         | Categories, Warehouses                                                    |
| System            | Settings, Email templates, Audit log                                     |

This is purely additive metadata — `PERMISSIONS`, `PERMISSION_KEYS`, the implied/
escalation/compat logic are untouched. The catalog is served unchanged via
`role.service.listPermissionGroups()` → controller → API.

### 2. Frontend — shared `PermissionMatrix` component

New file `frontend/src/components/dashboard/users-roles/roles/PermissionMatrix.tsx`,
extracted from the duplicated markup in `RoleForm` and `RoleDetail`.

Props:

- `groups: PermissionGroup[]`
- `granted: Set<string>` (or string[]) — currently-granted keys
- `onToggle?(group, key)` — when omitted, the matrix is read-only (static chips)

Renders:

- **Search bar** — live filter over module labels + action labels; auto-expands
  categories containing a match; "no matches" empty state.
- **Category sections** — collapsible header: chevron, category name, `N modules`,
  and a granted-count badge (`8 granted`) so collapsed sections still convey state.
  In edit mode the header carries subtle bulk text-actions: **Grant view** · **Clear**.
- **Module rows** — child groups indented with a connector under their parent
  (`customers`). Action chips reuse the existing accent-pill style. In edit mode a
  trailing **All** chip toggles every action in the row.
- **Full access** (`*` roles) — unchanged "Full access" notice; matrix not rendered.

`frontend/src/types/role.ts` `PermissionGroup` mirrors `category` + `parent`.

### 3. Interaction rules (preserved)

- Enabling any action auto-adds the module's `View`; disabling `View` clears the module
  (existing `togglePerm` logic, lifted into the matrix or passed in).
- Bulk **Grant view** sets only the `view` keys of the category's modules.
- **Clear** removes every key in the category.
- Server-side implications (`applyImpliedPermissions`, customer-child → `customers.view`)
  are unchanged and remain the backstop.

### 4. Default collapse state — "smart"

Categories with ≥1 granted permission start expanded; empty categories start collapsed.
A brand-new role (nothing granted) starts all-collapsed for a clean overview.

### 5. Styling

Reuses existing CSS variables and chip classes — no new tokens; theme/density/radius
aware out of the box.

## Out of scope

- No change to permission semantics, escalation guards, or migration logic.
- No change to the roles list page.
- No new permission keys.

## Verification

- Backend: `pnpm typecheck`, `pnpm lint`, `pnpm test` (vitest — `permissions.test.ts`
  updated for the new fields).
- Frontend: `pnpm lint`, `pnpm build`.
