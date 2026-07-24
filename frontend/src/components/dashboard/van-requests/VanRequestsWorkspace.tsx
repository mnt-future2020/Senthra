"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { VanRequestDetail } from "./VanRequestDetail";
import { VanRequestsBoard } from "./VanRequestsBoard";
import { WalkInIssue } from "./WalkInIssue";

// The "Field Stock Requests" tab of a warehouse: the queue, ONE request's review workspace, or the
// walk-in composer — never two at once. Which one is in the URL (`?vRequest=VSR-0030`, `?vNew=walkIn`),
// so a refresh, a browser Back, or a link pasted to a colleague all restore the same view — and the
// reviewer never leaves the warehouse.
//
// This lives inside WarehouseDetail's `fill` box (min-h-0 flex-1 overflow-hidden), so whichever child
// renders owns the full tab height and does its own scrolling. That is what these views need and what
// a `<Modal size="lg">` could not give them: the review table has a per-line source-warehouse picker
// (inside a 32rem box the warehouse names truncated and the table scrolled sideways), and the walk-in
// composer stacks a catalogue search over a cart that the backend lets run to 100 lines.
//
// The request param carries the CODE, not the db id — the backend's getOne takes either, so the URL is
// readable when shared. Any old `?vReq=<objectId>` link still resolves, but is no longer written.
export function VanRequestsWorkspace({ warehouse }: { warehouse: { id: string; name: string; code: string } }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const openCode = searchParams.get("vRequest");
  const composing = searchParams.get("vNew") === "walkIn";

  const url = React.useCallback((patch: Record<string, string | null>) => {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    return `${window.location.pathname}?${params.toString()}`;
  }, []);

  // push, not replace: opening a request or the composer is a navigation, so browser Back returns to
  // the queue with its filters/page intact (they live in the same URL). The board's own filter writes
  // stay `replace`.
  const open = React.useCallback((code: string) => router.push(url({ vRequest: code }), { scroll: false }), [router, url]);
  const openWalkIn = React.useCallback(() => router.push(url({ vNew: "walkIn" }), { scroll: false }), [router, url]);

  // Prefer Back so we pop the entry we pushed (no history litter from queue→view→queue→…).
  // `historyDepth` only counts entries THIS document pushed, so a deep-linked visitor — whose Back
  // would leave the app entirely — falls through to an explicit replace onto the queue instead.
  //
  // `away` is deliberately ONE boolean over both views rather than a per-view count: what it tracks is
  // "is there a queue entry behind me to pop", and only queue→away is ever a push(). walkIn→detail is a
  // replace() (see onCreated), so it must NOT re-count — the single entry pushed on leaving the queue is
  // still the one Back pops. Any future view reached by push() has to increment this too.
  const away = openCode !== null || composing;
  const historyDepth = React.useRef(0);
  const awayRef = React.useRef(away);
  React.useEffect(() => {
    if (away && !awayRef.current) historyDepth.current += 1;
    else if (!away && awayRef.current) historyDepth.current = Math.max(0, historyDepth.current - 1);
    awayRef.current = away;
  }, [away]);

  const close = React.useCallback(() => {
    if (historyDepth.current > 0) router.back();
    else router.replace(url({ vRequest: null, vNew: null }), { scroll: false });
  }, [router, url]);

  // A fresh walk-in lands on its own request — go straight there rather than back to the queue, so the
  // reviewer can scan-fulfil it while the engineer is still standing at the counter.
  const onCreated = React.useCallback(
    (code: string) => router.replace(url({ vNew: null, vRequest: code }), { scroll: false }),
    [router, url],
  );

  if (openCode) {
    return <VanRequestDetail key={openCode} idOrCode={openCode} warehouseName={warehouse.name} currentWarehouseId={warehouse.id} onClose={close} />;
  }
  if (composing) {
    return <WalkInIssue warehouse={warehouse} onClose={close} onCreated={onCreated} />;
  }
  return <VanRequestsBoard warehouse={warehouse} onOpen={open} onWalkIn={openWalkIn} />;
}
