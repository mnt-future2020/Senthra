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

// Sent by the server to a device whose session has just been destroyed — evicted by the one-device
// cap, signed out from another device, or wiped by a password change. Name and reasons mirror
// SESSION_REVOKED_EVENT / SessionRevokedReason in the backend's lib/realtime.ts; change together.
export const SESSION_REVOKED_EVENT = "auth:session_revoked";

// Deliberately typed loose (`string`) at the boundary: the reason is turned into copy by
// signedOutNotice, which falls back to a generic line for anything it doesn't recognise. A newer
// server sending a reason this build has never heard of must still sign the user out.
export interface SessionRevokedPayload {
  reason?: string;
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

/**
 * Subscribe to the server's "your session was revoked" push.
 *
 * Separate from subscribe() above on purpose — that one re-runs its handler on every RECONNECT so
 * data consumers can catch up on missed events, which for a sign-out handler would mean a passing
 * network blip logging the user out. This one listens to the single event and nothing else.
 *
 * Holding this subscription is also what keeps ONE socket open for the whole authenticated session,
 * so the push arrives on pages that have no other realtime consumer (a settings screen, the customer
 * portal). It shares the same refcounted connection as every other subscriber, so it costs no extra
 * websocket.
 */
export function onSessionRevoked(handler: (reason: string | undefined) => void): () => void {
  const s = getSocket();
  refCount += 1;
  const listener = (payload?: SessionRevokedPayload) => handler(payload?.reason);
  s.on(SESSION_REVOKED_EVENT, listener);

  return () => {
    s.off(SESSION_REVOKED_EVENT, listener);
    refCount -= 1;
    if (refCount === 0) {
      socket?.disconnect();
      socket = null;
    }
  };
}
