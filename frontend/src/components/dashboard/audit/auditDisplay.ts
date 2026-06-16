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
  partially_received: "create",
  fully_received: "create",
  attachment_added: "create",
  attachment_removed: "delete",
};

export function actionTone(action: string): ActionTone {
  const verb = action.split(".").pop() ?? "";
  return VERB_TONE[verb] ?? "neutral";
}

// Tailwind classes per tone (uses the app's CSS variables / a small fixed palette).
export const TONE_CLASSES: Record<ActionTone, string> = {
  create: "bg-emerald-500/12 text-emerald-600",
  update: "bg-amber-500/12 text-amber-600",
  delete: "bg-rose-500/12 text-rose-600",
  auth: "bg-sky-500/12 text-sky-600",
  neutral: "bg-[var(--surface-2)] text-[var(--muted)]",
};

// "customer.project.created" → "Customer · Project · Created"
export function actionLabel(action: string): string {
  return action
    .split(".")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
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
