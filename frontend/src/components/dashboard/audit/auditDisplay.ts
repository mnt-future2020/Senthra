// Presentation helpers for audit actions. Audit `action` keys are dotted verbs
// like "customer.project.created". We humanize unmapped keys and color them by
// the trailing verb so the table reads at a glance and future actions still render.

export type ActionTone = "create" | "update" | "delete" | "auth" | "neutral";

const VERB_TONE: Record<string, ActionTone> = {
  created: "create",
  updated: "update",
  deleted: "delete",
  login: "auth",
  logout: "auth",
  // Customer stock-request lifecycle — coloured to match the portal status pills:
  // amber while awaiting review, green when approved, red when rejected.
  submitted: "update",
  approved: "create",
  rejected: "delete",
  // Warehouse lifecycle — activate / assign read as positive, deactivate / remove as
  // negative, default change as an update.
  activated: "create",
  deactivated: "delete",
  // HISTORICAL: warehouses no longer carry a manager field (managers are derived from the Users &
  // Roles assignments), but existing audit rows still use these actions and must keep rendering.
  manager_assigned: "create",
  manager_removed: "delete",
  default_changed: "update",
  // Supplier owner lifecycle — assign reads as positive, remove as negative.
  owner_assigned: "create",
  owner_removed: "delete",
  // Purchase order lifecycle — issue reads as an update, receipt as positive,
  // cancel as negative, close as a neutral terminal; attachments add/remove.
  sent: "update",
  closed: "neutral",
  cancelled: "delete",
  // Goods In lifecycle — completing a receipt posts stock (positive).
  completed: "create",
  partially_received: "create",
  fully_received: "create",
  attachment_added: "create",
  attachment_removed: "delete",
  // Warehouse Inventory — a stock transfer is a movement (update); a CSV export is a neutral read.
  transfer: "update",
  viewed: "neutral",
  // Goods Out — dispatching stock to an engineer is a movement (update).
  dispatched: "update",
  // Lifecycle acceptance — a job/transfer/PO accepted or acknowledged is a positive confirmation.
  accepted: "create",
  supplier_accepted: "create",
  acknowledged: "create",
  started: "update",
  // Refusals read as negative, matching `rejected` above. VSR + engineer transfers + kit requests
  // all use `declined` rather than `rejected`, so it needs its own entry.
  declined: "delete",
  overridden: "delete",
  // Goods Management scan flow — issuing/returning stock is a movement; reconcile closes the job
  // (neutral terminal, like `closed`); restoring damaged stock to usable is positive.
  issued: "update",
  return_posted: "update",
  reconciled: "neutral",
  // An attempt that COULD NOT close the job — hired kit was still out with an engineer. Its own tone
  // because it is not a close: reading it as neutral-terminal beside the real ones would put a line in
  // the trail saying a job finished when the whole point of the entry is that it did not.
  reconcile_deferred: "update",
  // Hire custody. Declaring somebody else's equipment gone is the negative one; finding it again is
  // the recovery, and it reads positive for the same reason `damaged_restored` does — the pair has to
  // be legible as opposites rather than both falling through to the default grey.
  declared_lost: "delete",
  loss_recovered: "create",
  // Booking stock as lost is a write-off, not a tidy-up: it reads negative so it never blends into the
  // neutral "reconciled" lines it used to be recorded as.
  written_off_lost: "delete",
  damaged_restored: "create",
  // Its exact inverse — units leaving usable stock. Negative, so the pair reads as opposites in the
  // trail instead of one being coloured and the other falling through to the default grey.
  damage_reported: "delete",
  // Field Stock (VSR) — a posting moves stock; walk-in creates a pre-approved request; closing short
  // is a neutral terminal (the shortfall is accepted and recorded, not an error); cancelling
  // remainder is negative. `closed_short` is keyed on the verb alone, so customer consignment's
  // `customer.stock_request.closed_short` lands here too — deliberately, since it means the same
  // thing there (the delivery is finished, the missing units are simply not coming). Neither case is
  // a write-off: nothing is drained from a ledger, the leg is just closed with a reason.
  fulfilment_posted: "update",
  walk_in_created: "create",
  closed_short: "neutral",
  cancelled_remaining: "delete",
  // Inventory adjustments — adding stock is positive, an adjustment is a correction (update).
  stock_added: "create",
  stock_adjusted: "update",
  transferred: "update",
  received: "create",
  // Assignment lifecycle — assign reads positive, unassign negative.
  assigned: "create",
  warehouse_assigned: "create",
  warehouse_unassigned: "delete",
  // Record/content lifecycle.
  created_by_admin: "create",
  bulk_imported: "create",
  duplicated: "create",
  restored: "create",
  kit_line_added: "create",
  barcode_generated: "create",
  invite_resent: "update",
  profile_updated: "update",
  delivery_date_updated: "update",
  signature_uploaded: "create",
  signature_removed: "delete",
};

// Verb suffixes checked (longest-first) when the full verb isn't in VERB_TONE. This keeps a NEW
// action like `foo.delivery_window_updated` reading as an update instead of silently going grey —
// the map above stays the source of truth, this is only the safety net.
//
// Order matters: longer suffixes win, so `_unassigned` is tested before `_assigned` and can't be
// mis-toned as positive. Every suffix is `_`-prefixed so it only ever matches a whole trailing word
// (`cancelled_remaining` does NOT match `cancelled`, which is why it's mapped explicitly above).
const SUFFIX_TONE: ReadonlyArray<readonly [string, ActionTone]> = [
  ["_unassigned", "delete"],
  ["_removed", "delete"],
  ["_deleted", "delete"],
  ["_rejected", "delete"],
  ["_declined", "delete"],
  ["_cancelled", "delete"],
  ["_created", "create"],
  ["_added", "create"],
  ["_assigned", "create"],
  ["_uploaded", "create"],
  ["_generated", "create"],
  ["_approved", "create"],
  ["_accepted", "create"],
  ["_restored", "create"],
  ["_updated", "update"],
  ["_posted", "update"],
  ["_changed", "update"],
];

export function actionTone(action: string): ActionTone {
  const verb = action.split(".").pop() ?? "";
  const exact = VERB_TONE[verb];
  if (exact) return exact;
  for (const [suffix, tone] of SUFFIX_TONE) if (verb.endsWith(suffix)) return tone;
  return "neutral";
}

// Tailwind classes per tone (uses the app's CSS variables / a small fixed palette).
export const TONE_CLASSES: Record<ActionTone, string> = {
  create: "bg-emerald-500/12 text-emerald-600",
  update: "bg-amber-500/12 text-amber-600",
  delete: "bg-rose-500/12 text-rose-600",
  auth: "bg-sky-500/12 text-sky-600",
  neutral: "bg-[var(--surface-2)] text-[var(--muted)]",
};

// "customer.stock_request.submitted" → "Customer · Stock Request · Submitted".
// Each dotted segment is a domain/entity/verb; underscores within a segment are word breaks, so
// they become spaced, Title-Cased words (a multi-word entity like `stock_request` reads naturally
// instead of "Stock_request").
export function actionLabel(action: string): string {
  return action
    .split(".")
    .map((part) =>
      part
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" "),
    )
    .join(" · ");
}

// "email_template" → "Email Template", "customer" → "Customer". Used for the
// actor-type and target-type (domain) filter labels.
export function humanizeType(value: string): string {
  return value
    .split(/[._]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Relative time for the table ("2h ago"); the cell title shows the absolute time.
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

// Extract the human-readable change labels from an audit entry's metadata, when the action recorded
// a field-level diff (procurement edits write `{ changes: [{ label, … }] }`). Returns [] for any
// other shape so callers can render "· N changes" only when there's something to show. Safe against
// the metadata's `unknown` type — every access is guarded.
export function changeLabels(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const changes = (metadata as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return [];
  return changes
    .map((c) => (c && typeof c === "object" ? (c as { label?: unknown }).label : null))
    .filter((l): l is string => typeof l === "string" && l.length > 0);
}
