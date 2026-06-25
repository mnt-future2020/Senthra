"use client";

import * as React from "react";
import { io, type Socket } from "socket.io-client";

import { env } from "@/lib/env";
import { useAuth } from "@/hooks/useAuth";

// Connects to the backend socket server and invokes `onChange` whenever a
// goods-management event fires ("goods:issued", "goods:returned", "goods:updated").
// Mirrors the useJobSocket pattern; tears down on unmount / logout.
const GOODS_EVENTS = ["goods:issued", "goods:returned", "goods:updated"] as const;

function socketOrigin(): string {
  try {
    return new URL(env.apiUrl).origin;
  } catch {
    return env.apiUrl;
  }
}

export function useGoodsSocket(onChange: () => void): void {
  const { principal } = useAuth();
  const cb = React.useRef(onChange);
  // Write the ref in an effect so we always use the latest callback without
  // tearing down the socket connection every render.
  React.useEffect(() => {
    cb.current = onChange;
  });

  React.useEffect(() => {
    if (!principal) return; // only connect when authenticated

    const socket: Socket = io(socketOrigin(), {
      withCredentials: true, // send the httpOnly auth cookies on the handshake
      transports: ["websocket"], // skip the long-poll upgrade
    });

    const handler = () => cb.current();
    GOODS_EVENTS.forEach((ev) => socket.on(ev, handler));

    return () => {
      GOODS_EVENTS.forEach((ev) => socket.off(ev, handler));
      socket.disconnect();
    };
  }, [principal]); // reconnect if the principal changes (login/logout)
}
