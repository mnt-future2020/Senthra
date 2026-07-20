"use client";

import * as React from "react";

import { subscribe } from "@/lib/socket";
import { useAuth } from "@/hooks/useAuth";

// Invokes `onChange` whenever a purchase request moves through the procurement flow — submitted,
// approved, rejected, reopened for revision, cancelled or converted to a PO — so the caller can
// refresh its list/detail. A PRF passes through several hands in sequence (raiser → finance
// approver → procurement, who converts it), so a screen left open on one desk goes stale the moment
// somebody else acts on it.
//
// Also fires after any RECONNECT (see lib/socket.ts), to recover events missed while offline.
// Gated on an authenticated principal; subscribes through the shared tab-wide socket and tears
// down on unmount / logout. The server only fans these out to the purchase_requests.view room, and
// the payload is a scope-agnostic refetch signal — every consumer re-pulls through its own
// warehouse-scoped REST call.
const PRF_EVENTS = ["purchase_request:updated"] as const;

export function usePurchaseRequestSocket(onChange: () => void): void {
  const { principal } = useAuth();
  const cb = React.useRef(onChange);
  // Keep the latest callback without re-subscribing — write the ref in an effect
  // (mutating a ref during render is disallowed by the react-hooks lint rules).
  React.useEffect(() => {
    cb.current = onChange;
  });

  React.useEffect(() => {
    if (!principal) return; // only connect when authenticated
    return subscribe(PRF_EVENTS, () => cb.current());
  }, [principal]); // re-subscribe if the principal changes (login/logout)
}
