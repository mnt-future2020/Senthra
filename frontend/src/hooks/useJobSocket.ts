"use client";

import * as React from "react";

import { subscribe } from "@/lib/socket";
import { useAuth } from "@/hooks/useAuth";

// Invokes `onChange` whenever a job is created/assigned ("job:new"), accepted
// ("job:accepted"), rejected ("job:rejected") or deleted ("job:deleted") so the caller can
// refresh its list — and again after any reconnect, to recover events missed while offline.
// Gated on an authenticated principal; subscribes through the shared tab-wide socket
// (see lib/socket.ts) and tears down on unmount / logout.
const JOB_EVENTS = ["job:new", "job:accepted", "job:rejected", "job:deleted"] as const;

export function useJobSocket(onChange: () => void): void {
  const { principal } = useAuth();
  const cb = React.useRef(onChange);
  // Keep the latest callback without re-subscribing — write the ref in an effect
  // (mutating a ref during render is disallowed by the react-hooks lint rules).
  React.useEffect(() => {
    cb.current = onChange;
  });

  React.useEffect(() => {
    if (!principal) return; // only connect when authenticated
    return subscribe(JOB_EVENTS, () => cb.current());
  }, [principal]); // re-subscribe if the principal changes (login/logout)
}
