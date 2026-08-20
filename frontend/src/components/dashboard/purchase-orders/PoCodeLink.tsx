"use client";

import Link from "next/link";

import { useAuth } from "@/hooks/useAuth";

/**
 * A purchase order's code, linked ONLY for somebody who can open the order.
 *
 * `/dashboard/purchase-orders/[id]` is gated on `purchase_orders.view`, so an actor without it who
 * follows one of these lands on the padlock panel. That is the same defect the attention catalog
 * already names and solves with `hrefPerms` — "a link is only emitted if the actor can open it... a
 * chip whose destination would refuse this actor loses its href and renders as a plain number".
 *
 * The combination is real, not theoretical: `rentals.view` and `purchase_orders.view` are separate
 * keys, so a role that curates the rental catalogue without procurement access sees hire rows whose
 * every order reference would dead-end. The seeded warehouse manager holds both and is unaffected —
 * which is exactly why this was invisible.
 *
 * ONE component rather than the same check copied into each surface: five copies of a permission rule
 * is five chances for the sixth surface to forget it.
 */
export function PoCodeLink({ code, className }: { code: string; className?: string }) {
  const { can } = useAuth();
  const cls = className ?? "font-mono font-bold text-[var(--accent)]";

  if (!can("purchase_orders.view")) return <span className={cls}>{code}</span>;

  return (
    <Link
      href={`/dashboard/purchase-orders/${code}`}
      // Several of these sit inside rows that navigate on click. Stopping here means the link goes
      // where the link says and the row is not also fired — and it costs nothing where the row is
      // inert.
      onClick={(e) => e.stopPropagation()}
      className={`${cls} hover:underline`}
    >
      {code}
    </Link>
  );
}
