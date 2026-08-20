"use client";

import * as React from "react";

import { subscribe } from "@/lib/socket";
import { useAuth } from "@/hooks/useAuth";

// Invokes `onChange` whenever a hire moves — received, returned, damaged, extended, marked returned,
// or any of those voided — so the caller can refresh its list/detail.
//
// A hire is worked by people in different buildings: a PM raises the order, a warehouse books the kit
// in, a site reports it broken, the warehouse hands it back. Every one of those surfaces is a list
// somebody leaves open, and a stale receiving row is how the same delivery gets booked in twice.
//
// Also fires after any RECONNECT (see lib/socket.ts), to recover events missed while offline. Gated on
// an authenticated principal; subscribes through the shared tab-wide socket and tears down on unmount
// or logout. The server fans these out only to the `rentals.view` room, and the payload is a
// scope-agnostic refetch signal — every consumer re-pulls through its own scoped REST call.
const HIRE_EVENTS = ["rental_hire:updated"] as const;

interface HireEvent {
  purchaseOrderId: string;
  code: string;
}

/**
 * `onChange` receives the ORDER the movement happened on, so a detail screen can ignore everybody
 * else's hires instead of refetching itself on every event in the company. A list ignores the argument
 * and refetches on all of them, which is what it wants.
 */
export function useRentalHireStream(onChange: (purchaseOrderId: string, code: string) => void): void {
  const { principal } = useAuth();
  const cb = React.useRef(onChange);
  // Keep the latest callback without re-subscribing — written in an effect, because mutating a ref
  // during render is what the react-hooks lint rules refuse.
  React.useEffect(() => {
    cb.current = onChange;
  });

  React.useEffect(() => {
    if (!principal) return; // only connect when authenticated
    return subscribe(HIRE_EVENTS, (payload) => {
      // A reconnect replays with no payload — treat it as "something moved", which is exactly what it
      // means, and let the consumer decide whether to care.
      const e = (payload ?? {}) as Partial<HireEvent>;
      cb.current(e.purchaseOrderId ?? "", e.code ?? "");
    });
  }, [principal]); // re-subscribe if the principal changes (login/logout)
}
