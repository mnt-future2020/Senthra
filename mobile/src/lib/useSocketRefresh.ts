import { useEffect, useRef } from "react";
import { subscribe } from "./socket";
import { useAuth } from "./auth";

/**
 * Re-run `onChange` whenever any of `events` arrives on the shared socket (or
 * after a reconnect), so screens live-refresh like the web dashboard. Gated on
 * an authenticated principal; tears down on unmount / logout.
 */
export function useSocketRefresh(events: readonly string[], onChange: () => void): void {
  const { principal } = useAuth();
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  });

  const eventsKey = events.join(",");
  useEffect(() => {
    if (!principal) return;
    return subscribe(eventsKey.split(","), () => cb.current());
  }, [principal, eventsKey]);
}
