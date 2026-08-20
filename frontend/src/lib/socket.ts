"use client";

import { io, type Socket } from "socket.io-client";

import { env } from "@/lib/env";

// A single shared socket.io connection for the whole tab. Every realtime hook
// (useJobSocket, useGoodsSocket, …) subscribes through here instead of opening
// its own connection, so we hold ONE websocket per tab rather than one per
// mounted consumer — each connection otherwise costs a JWT verify + session
// lookup (+ office-room permission query) on the backend.

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

let socket: Socket | null = null;
let refCount = 0;

function getSocket(): Socket {
  if (!socket) {
    socket = io(socketOrigin(), {
      withCredentials: true, // send the httpOnly auth cookies on the handshake
      transports: ["websocket"], // skip the long-poll upgrade
    });
  }
  return socket;
}

/**
 * Subscribe `handler` to a set of server events on the shared connection.
 *
 * `handler` also runs on every successful RECONNECT: socket.io restores the
 * connection automatically, but events emitted while we were offline are gone,
 * so consumers must refetch to catch up — otherwise a transient network blip
 * leaves the UI silently stale until a manual refresh. (We hook the manager's
 * "reconnect", not "connect", so the initial connection doesn't trigger a
 * redundant refetch on top of the consumer's own mount fetch.)
 *
 * Returns an unsubscribe fn; the shared socket disconnects once the last
 * subscriber unsubscribes (unmount / logout).
 */
export function subscribe(
  events: readonly string[],
  // The event's payload, forwarded verbatim. Optional in the signature because a RECONNECT fires the
  // same handler with nothing — a consumer that reads the payload has to cope with its absence, and
  // one that ignores it (most of them) keeps its no-argument callback unchanged.
  handler: (payload?: unknown) => void,
): () => void {
  const s = getSocket();
  refCount += 1;
  events.forEach((ev) => s.on(ev, handler));
  s.io.on("reconnect", handler);

  return () => {
    events.forEach((ev) => s.off(ev, handler));
    s.io.off("reconnect", handler);
    refCount -= 1;
    if (refCount === 0) {
      socket?.disconnect();
      socket = null;
    }
  };
}
