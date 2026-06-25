"use client";

import * as React from "react";
import { io, type Socket } from "socket.io-client";

import { env } from "@/lib/env";
import { useAuth } from "@/hooks/useAuth";

// Connects to the backend socket server (same origin as the REST API) using the
// httpOnly auth cookie (withCredentials), and invokes `onChange` whenever a job is
// created/assigned ("job:new"), accepted ("job:accepted") or rejected ("job:rejected")
// so the caller can refresh its list. Gated on an authenticated principal; tears down on
// unmount / logout. One connection per mounted consumer.
const JOB_EVENTS = ["job:new", "job:accepted", "job:rejected", "job:deleted"] as const;

// The socket server lives at the API ORIGIN (scheme://host:port) — strip any path prefix on
// NEXT_PUBLIC_API_URL (e.g. ".../api") so the default /socket.io handshake isn't mistaken for a
// namespace. Falls back to the raw value if it isn't a parseable absolute URL.
function socketOrigin(): string {
  try {
    return new URL(env.apiUrl).origin;
  } catch {
    return env.apiUrl;
  }
}
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

    const socket: Socket = io(socketOrigin(), {
      withCredentials: true, // send the httpOnly auth cookies on the handshake
      transports: ["websocket"], // skip the long-poll upgrade
    });

    const handler = () => cb.current();
    JOB_EVENTS.forEach((ev) => socket.on(ev, handler));

    return () => {
      JOB_EVENTS.forEach((ev) => socket.off(ev, handler));
      socket.disconnect();
    };
  }, [principal]); // reconnect if the principal changes (login/logout)
}
