"use client";

import * as React from "react";

import { subscribe } from "@/lib/socket";
import { useAuth } from "@/hooks/useAuth";

// Invokes `onChange` whenever a purchase order moves through the procurement flow — submitted,
// approved, routed to a PM, sent to the supplier, accepted, received against, cancelled or closed —
// so the caller can refresh its list/detail. A PO passes through several hands in sequence (raiser
// → finance approver → PM → warehouse), so a screen left open on one desk goes stale the moment
// somebody else acts on it.
//
// Also fires after any RECONNECT (see lib/socket.ts), to recover events missed while offline.
// Gated on an authenticated principal; subscribes through the shared tab-wide socket and tears
// down on unmount / logout. The server only fans these out to the purchase_orders.view room, and
// the payload is a scope-agnostic refetch signal — every consumer re-pulls through its own
// warehouse-scoped REST call.
const PO_EVENTS = ["purchase_order:updated"] as const;

export function usePurchaseOrderSocket(onChange: () => void): void {
  const { principal } = useAuth();
  const cb = React.useRef(onChange);
  // Keep the latest callback without re-subscribing — write the ref in an effect
  // (mutating a ref during render is disallowed by the react-hooks lint rules).
  React.useEffect(() => {
    cb.current = onChange;
  });

  React.useEffect(() => {
    if (!principal) return; // only connect when authenticated
    return subscribe(PO_EVENTS, () => cb.current());
  }, [principal]); // re-subscribe if the principal changes (login/logout)
}
