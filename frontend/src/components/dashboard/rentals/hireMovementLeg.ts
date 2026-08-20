import type { ReceiptDirection } from "@/types/rental";

// How each leg of a hire READS — shared by the order page's movement panel and the register.
//
// One definition, because the two screens show the same records and a reader moving between them
// must not meet "Returned" on one and "Collection" on the other. The tone carries the same job: green
// for kit arriving, accent for kit going back, amber for damage.

/**
 * How each leg reads. The code already says which it is; this makes it readable without decoding.
 *
 * A direction with no entry is a record this build does not understand. It is rendered as its own
 * neutral row rather than falling back to "Delivered" — a fallback would put a green DELIVERED badge
 * and "its units go back to the hire" on the reversal of something that may be neither.
 */
export interface Leg {
  label: string;
  quantityLabel: string;
  tone: string;
  reversalNote: string;
}

/** What an unrecognised direction renders as — honest about not knowing, rather than guessing. */
export const UNKNOWN_LEG: Leg = {
  label: "Movement",
  quantityLabel: "damaged",
  tone: "bg-[var(--surface-2)] text-[var(--muted)]",
  reversalNote: "Its quantities are recomputed from the records that remain.",
};

export const LEG: Record<ReceiptDirection, Leg> = {
  in: {
    label: "Delivered",
    quantityLabel: "damaged on arrival",
    tone: "bg-[var(--pos,#16a34a)]/12 text-[var(--pos,#16a34a)]",
    reversalNote: "Its units go back to the hire — one that has received nothing else returns to awaiting delivery.",
  },
  out: {
    label: "Returned",
    quantityLabel: "damaged at collection",
    tone: "bg-[var(--accent)]/12 text-[var(--accent)]",
    reversalNote: "Its units go back ON hire, and a hire this record closed is reopened.",
  },
  damage: {
    label: "Damage report",
    quantityLabel: "damaged",
    tone: "bg-[var(--warn,#d97706)]/14 text-[var(--warn,#d97706)]",
    reversalNote: "No equipment moved, so none is given back — it withdraws the claim and the damaged count it added.",
  },
};

/** The leg a direction names, or the honest neutral row for one this build does not understand. */
export function legOf(direction: ReceiptDirection | string): Leg {
  return LEG[direction as ReceiptDirection] ?? UNKNOWN_LEG;
}
