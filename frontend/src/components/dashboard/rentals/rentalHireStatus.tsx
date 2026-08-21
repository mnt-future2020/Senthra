import type { HireStatus } from "@/types/rental";
import type { HireWindow } from "./hireWindow";

// Shared presentation for a hire. The STORED values are `awaiting_delivery` / `on_hire` / `returned` /
// `cancelled`; the UI says "Awaiting Delivery" / "On Hire" / "Returned" / "Cancelled". That mapping
// lives here only — no component spells a status out inline, which is the same rule prfStatus.tsx
// sets for purchase requests.

export const HIRE_STATUS_LABELS: Record<HireStatus, string> = {
  awaiting_delivery: "Awaiting Delivery",
  on_hire: "On Hire",
  returned: "Returned",
  // A hire nothing ever arrived against, closed short. Distinct from Returned because the two are
  // different facts and the finance register tells them apart — this one is not hire spend.
  cancelled: "Cancelled",
};

// Amber for awaiting: it is a step somebody still owes, the same tone the attention badge uses for
// "Hires not yet received". Not rose — nothing is wrong until the hire should already have started.
const HIRE_STATUS_CLASSES: Record<HireStatus, string> = {
  awaiting_delivery: "bg-amber-500/12 text-amber-600",
  on_hire: "bg-sky-500/12 text-sky-600",
  returned: "bg-emerald-500/12 text-emerald-600",
  // Neutral, not rose: closing short is a decision somebody made on purpose, not a fault. Rose here
  // would read as "something went wrong" on every properly-handled cancellation.
  cancelled: "bg-[var(--surface-2)] text-[var(--muted)]",
};

export function HireStatusBadge({ status }: { status: HireStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider ${
        HIRE_STATUS_CLASSES[status] ?? HIRE_STATUS_CLASSES.returned
      }`}
    >
      {HIRE_STATUS_LABELS[status] ?? status}
    </span>
  );
}

// The deadline window, coloured to match the attention badges: `attention` amber for a hire ending
// soon, `critical` rose once it has run out. A hire with time left carries no colour at all —
// colouring every row would leave nothing for the ones that need chasing.
const WINDOW_CLASSES: Record<HireWindow, string> = {
  ok: "text-[var(--muted)]",
  expiring: "text-amber-600 font-semibold",
  overdue: "text-rose-600 font-semibold",
};

export function HireDeadline({ window, children }: { window: HireWindow; children: React.ReactNode }) {
  return <span className={WINDOW_CLASSES[window]}>{children}</span>;
}
