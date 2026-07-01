"use client";

import * as React from "react";

import { subscribe } from "@/lib/socket";
import { useAuth } from "@/hooks/useAuth";

// Invokes `onChange` whenever a goods-management event fires ("goods:issued",
// "goods:returned", "goods:updated") or an engineer transfer event fires
// ("engineer:transfer_updated") — and again after any reconnect, to recover events missed
// while offline. Subscribes through the shared tab-wide socket (see lib/socket.ts);
// gated on an authenticated principal; tears down on unmount / logout.
const GOODS_EVENTS = [
  "goods:issued",
  "goods:returned",
  "goods:updated",
  "engineer:transfer_updated",
] as const;

export function useGoodsSocket(onChange: () => void): void {
  const { principal } = useAuth();
  const cb = React.useRef(onChange);
  // Write the ref in an effect so we always use the latest callback without
  // tearing down the subscription every render.
  React.useEffect(() => {
    cb.current = onChange;
  });

  React.useEffect(() => {
    if (!principal) return; // only connect when authenticated
    return subscribe(GOODS_EVENTS, () => cb.current());
  }, [principal]); // re-subscribe if the principal changes (login/logout)
}
