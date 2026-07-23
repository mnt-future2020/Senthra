import type { EngineerOverview } from "@/types/engineer";

// Pure view-model builders: map the overview (+ the client-fetched customer/misc pool counts) and the
// actor's permissions to plain, serialisable card / attention-row descriptors. Kept free of React/JSX
// so the permission, deep-link and copy logic is unit-tested in isolation (engineerDashboardModel.test.ts);
// the components only render these.

export type CardTone = "neutral" | "accent" | "amber";
export type RowTone = "accent" | "amber" | "red";
export type CardIcon = "inbox" | "wrench" | "boxes" | "arrowRightLeft" | "truck" | "users";
export type RowIcon = "inbox" | "alertTriangle" | "truck" | "arrowRightLeft" | "wrench";

export interface StatCardModel {
  key: string;
  iconKey: CardIcon;
  tone: CardTone;
  value: number;
  label: string;
  hint: string;
  hintTone?: "red";
  href: string;
}

export interface AttentionRowModel {
  key: string;
  iconKey: RowIcon;
  tone: RowTone;
  text: string;
  // Most rows deep-link to where the work is done. A row with no href is informational only (rendered
  // non-clickable) — e.g. kit requests, which the engineer can't action and which have no aggregate view.
  href?: string;
}

const s = (n: number) => (n === 1 ? "" : "s");

// The workload / holdings cards — permission-gated, each deep-linking to its already URL-filterable list.
export function buildStatCards(o: EngineerOverview, can: (p: string) => boolean): StatCardModel[] {
  const canJobs = can("engineer.jobs.view");
  const canTransfers = can("engineer.transfer");
  const canVanStock = can("engineer.van_stock.request");
  const canInventory = can("engineer.inventory.view");
  const cards: StatCardModel[] = [];

  if (canJobs) {
    cards.push({
      key: "toAccept",
      iconKey: "inbox",
      tone: o.jobs.toAccept > 0 ? "amber" : "neutral",
      value: o.jobs.toAccept,
      label: "Jobs to accept",
      hint: o.jobs.toAccept > 0 ? "awaiting your response" : "nothing waiting",
      href: "/dashboard/engineer/jobs?status=assigned",
    });
    cards.push({
      key: "inProgress",
      iconKey: "wrench",
      tone: "accent",
      value: o.jobs.inProgress,
      label: "In progress",
      hint:
        o.jobs.overdue > 0
          ? `${o.jobs.overdue} overdue`
          : o.jobs.accepted > 0
            ? `${o.jobs.accepted} accepted, not started`
            : o.jobs.dueThisWeek > 0
              ? `${o.jobs.dueThisWeek} due this week`
              : "nothing due this week",
      hintTone: o.jobs.overdue > 0 ? "red" : undefined,
      href: "/dashboard/engineer/jobs?status=in_progress",
    });
  }

  if (canVanStock) {
    cards.push({
      key: "vanStock",
      iconKey: "truck",
      tone: o.vanStock.toCollect > 0 ? "accent" : "neutral",
      value: o.vanStock.toCollect,
      label: "Field stock to collect",
      hint: o.vanStock.toCollect > 0 ? "ready at a warehouse" : "nothing to collect",
      // `toCollect` counts approved + partially_fulfilled, so link to the "collectible" composite filter
      // (not bare `approved`) or the list would show fewer rows than the card's number.
      href: "/dashboard/engineer/van-stock?status=collectible",
    });
  }

  if (canTransfers) {
    cards.push({
      key: "transfers",
      iconKey: "arrowRightLeft",
      tone: o.transfers.incomingPending > 0 ? "accent" : "neutral",
      value: o.transfers.incomingPending,
      label: "Transfers pending",
      hint: o.transfers.incomingPending > 0 ? "waiting for your acceptance" : "inbox clear",
      // Deep-link to the pending filter, not the bare tab — the card counts pending incoming transfers,
      // so landing on the unfiltered tab would bury them among completed/declined rows.
      href: "/dashboard/engineer/transfers?view=incoming&status=pending",
    });
  }

  // Both stock cards require inventory access — they link to the Stock page (gated by the same
  // permission), so an actor without it would only bounce off the route guard. The misc (free-text)
  // count rides in the Stock card's hint rather than taking a card of its own.
  if (canInventory) {
    cards.push({
      key: "stock",
      iconKey: "boxes",
      tone: "neutral",
      value: o.stock.totalQuantity,
      label: "Stock on hand",
      hint: `${o.stock.lines} item${s(o.stock.lines)} held${o.misc.lines > 0 ? ` · ${o.misc.lines} misc` : ""}`,
      href: "/dashboard/engineer/inventory",
    });
    cards.push({
      key: "customer",
      iconKey: "users",
      tone: "neutral",
      value: o.customerStock.totalQuantity,
      label: "Customer stock",
      hint: o.customerStock.lines > 0 ? `${o.customerStock.lines} item${s(o.customerStock.lines)} held for customers` : "none held",
      href: "/dashboard/engineer/inventory?section=customer",
    });
  }

  return cards;
}

// The "Needs your attention" rows — one per actionable signal that is currently non-zero.
export function buildAttentionRows(o: EngineerOverview, can: (p: string) => boolean): AttentionRowModel[] {
  const canJobs = can("engineer.jobs.view");
  const canTransfers = can("engineer.transfer");
  const canVanStock = can("engineer.van_stock.request");
  const canRequestKit = can("engineer.jobs.request_kit");
  const rows: AttentionRowModel[] = [];

  if (canJobs && o.jobs.toAccept > 0)
    rows.push({ key: "accept", iconKey: "inbox", tone: "amber", text: `${o.jobs.toAccept} job${s(o.jobs.toAccept)} waiting for you to accept or reject`, href: "/dashboard/engineer/jobs?status=assigned" });
  if (canJobs && o.jobs.overdue > 0)
    rows.push({ key: "overdue", iconKey: "alertTriangle", tone: "red", text: `${o.jobs.overdue} active job${o.jobs.overdue === 1 ? " is" : "s are"} past the completion date`, href: "/dashboard/engineer/jobs?status=overdue" });
  if (canVanStock && o.vanStock.toCollect > 0)
    rows.push({ key: "collect", iconKey: "truck", tone: "accent", text: `${o.vanStock.toCollect} field-stock request${s(o.vanStock.toCollect)} ready to collect`, href: "/dashboard/engineer/van-stock?status=collectible" });
  if (canTransfers && o.transfers.incomingPending > 0)
    rows.push({ key: "transfers", iconKey: "arrowRightLeft", tone: "accent", text: `${o.transfers.incomingPending} incoming transfer${s(o.transfers.incomingPending)} to accept`, href: "/dashboard/engineer/transfers?view=incoming&status=pending" });
  if (canTransfers && o.transfers.toSign > 0)
    rows.push({ key: "sign", iconKey: "arrowRightLeft", tone: "amber", text: `${o.transfers.toSign} delivered transfer${s(o.transfers.toSign)} awaiting your signature`, href: "/dashboard/engineer/transfers?view=outgoing" });
  if (canRequestKit && o.kitRequests.pending > 0)
    // Informational (no href): kit requests are raised + tracked inside each job's detail page, and the
    // engineer can't action a pending one anyway — only the planner reviews it. So this row reports
    // status without deep-linking to a non-existent aggregate view.
    rows.push({ key: "kit", iconKey: "wrench", tone: "accent", text: `${o.kitRequests.pending} kit request${s(o.kitRequests.pending)} awaiting the planner` });

  return rows;
}
