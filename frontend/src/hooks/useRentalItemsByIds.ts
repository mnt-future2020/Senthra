"use client";

import * as React from "react";

import { chunkIds } from "@/lib/cataloguePicker";
import { listRentalItems } from "@/services/rental.service";
import type { RentalItem } from "@/types/rental";

/**
 * Resolve specific rental catalogue items by id, in as few requests as the server's bound allows.
 *
 * The rental twin of `useIrmItemsByIds`, and needed for a sharper reason: a saved PRF rental line
 * stores only `itemName`, with no code, so unlike an item line there is nothing to build a proper
 * picker label from locally. Without this, reopening a request whose rental item sits outside the
 * page loaded at mount showed an EMPTY picker on a line that is in fact set.
 *
 * It is deliberately a batch — a request with six rental lines resolves them in one call, not six —
 * and split past `MAX_IDS_PER_LOOKUP`, because one oversized request comes back short rather than
 * failing. `ids` is sent to the list endpoint, which ANDs it with the caller's normal filters, so
 * this can only ever narrow what the user is allowed to see.
 *
 * See `useIrmItemsByIds` for why a response is never discarded on a dependency change, and why the
 * in-flight count rather than "the id isn't in my list yet" is what a caller should render as
 * loading. On this form that second point was the visible half of the bug: a failed or cancelled
 * lookup left a saved rental line reading "Loading rental items…" for as long as the form was open.
 *
 * @returns whether a lookup is still in flight.
 */
export function useRentalItemsByIds(ids: string[], onResolved: (items: RentalItem[]) => void): boolean {
  const requested = React.useRef(new Set<string>());
  const onResolvedRef = React.useRef(onResolved);
  React.useEffect(() => {
    onResolvedRef.current = onResolved;
  });

  // Set in the effect BODY, not just cleared in its cleanup — see the IRM twin.
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [inFlight, setInFlight] = React.useState(0);

  // Joined so the effect re-runs on the SET of ids, not on the array identity a parent rebuilds
  // every render.
  const key = ids.join(",");

  React.useEffect(() => {
    const wanted = key.split(",").filter(Boolean).filter((id) => !requested.current.has(id));
    if (wanted.length === 0) return;
    for (const id of wanted) requested.current.add(id);

    const batches = chunkIds(wanted);
    setInFlight((n) => n + batches.length);
    for (const batch of batches) {
      listRentalItems({ ids: batch, pageSize: batch.length }).then(
        (page) => {
          if (mounted.current && page.items.length) onResolvedRef.current(page.items);
          setInFlight((n) => n - 1);
        },
        () => {
          for (const id of batch) requested.current.delete(id);
          setInFlight((n) => n - 1);
        },
      );
    }
  }, [key]);

  return inFlight > 0;
}
