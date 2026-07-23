import { io, type Socket } from "socket.io-client";
import { getAccessToken } from "./api";

// A single shared socket.io connection for the whole app, mirroring the web's
// lib/socket.ts: every realtime hook subscribes through here so we hold ONE
// websocket rather than one per mounted consumer. The handshake sends the
// access token via the socket.io `auth` payload (the backend reads its cookie
// first, then this token — same order as the REST middleware).

const BASE = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/+$/, "");

let socket: Socket | null = null;
let refCount = 0;

function getSocket(): Socket {
  if (!socket) {
    socket = io(BASE, {
      transports: ["websocket"],
      // Function form: re-evaluated on every (re)connect so a refreshed token is used.
      auth: (cb) => cb({ token: getAccessToken() }),
    });
  }
  return socket;
}

/**
 * Subscribe `handler` to a set of server events on the shared connection.
 *
 * `handler` also runs on every successful RECONNECT — events emitted while the
 * app was offline are gone, so consumers refetch to catch up. Returns an
 * unsubscribe fn; the shared socket disconnects once the last subscriber
 * unsubscribes (screen unmount / logout).
 */
export function subscribe(events: readonly string[], handler: () => void): () => void {
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
