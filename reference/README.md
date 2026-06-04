# UI Reference (frozen snapshot — not part of any build)

This folder is a **read-only design reference** for the placeholder / demo
dashboard screens that shipped with the starter UI:

- **Overview**, **Analytics**, **Customers**, **Invoices**, **Products**, **Messages**

These screens rendered **static / mock data** (they were never wired to the
backend). They have since been **removed from the live app**, so this folder is now
the **only copy** — kept so the original UI and its sample data can still be
referenced when building the real, data-backed features.

## Outside the build

This folder lives at the **repo root**, outside `frontend/` and `backend/`, so no
project's tooling touches it. It is **never type-checked, linted, or bundled** and
can't break a build. The `@/…` imports inside these files point at the old frontend
paths (most now deleted) — that's expected; the files are here for **reading**, not
compiling.

## What's here, and where it originally lived (in `frontend/`)

| Reference file | Original location | Status in live app |
| --- | --- | --- |
| `pages/overview.tsx` | `src/app/dashboard/page.tsx` | replaced with a redirect to Settings |
| `pages/analytics.tsx` | `src/app/dashboard/analytics/page.tsx` | removed |
| `pages/customers.tsx` | `src/app/dashboard/customers/page.tsx` | removed |
| `pages/invoices.tsx` | `src/app/dashboard/invoices/page.tsx` | removed |
| `pages/products.tsx` | `src/app/dashboard/products/page.tsx` | removed |
| `pages/messages.tsx` | `src/app/dashboard/messages/page.tsx` | removed |
| `tabs/*.tsx` | `src/components/dashboard/tabs/*.tsx` | removed |
| `data/dashboard.ts` | `src/data/dashboard.ts` | removed |
| `types/dashboard.ts` | `src/types/dashboard.ts` | removed |
| `providers/DashboardProvider.tsx` | `src/providers/DashboardProvider.tsx` | **slimmed** (kept for real infra only) |

## Where the static data lived

- **`data/dashboard.ts`** — the seed arrays (`INITIAL_TXN`, `INITIAL_CHANNELS`,
  `INITIAL_NOTIFICATIONS`) used by the Overview and Invoices screens.
- **`tabs/AnalyticsTab.tsx`, `tabs/CustomersTab.tsx`, `tabs/ProductsTab.tsx`,
  `tabs/MessagesTab.tsx`** — these screens held their own mock data **inline**
  (they took no props).
- **`providers/DashboardProvider.tsx`** — the stat cards (revenue / users / orders /
  refund rate) were **computed** here from the transaction list.

> ℹ️ **About `DashboardProvider`:** the live app still has a provider at
> `frontend/src/providers/DashboardProvider.tsx`, but it was **slimmed down** to
> just the real shared infrastructure (theme / accent / density + toasts). The copy
> here is the **original full version** — kept only to show how the demo data and
> stat cards were wired.

## How to use this

When building the real version of one of these screens, open the matching
`tabs/*.tsx` here to copy layout, class names, and component structure — then point
it at the real service/API instead of the mock data.
