"use client";

import * as React from "react";

import { chunkIds } from "@/lib/cataloguePicker";
import { listIrmItems } from "@/services/irm.service";
import type { IrmItem } from "@/types/irm";

/**
 * Resolve specific catalogue items by id, in as few requests as the server's bound allows.
 *
 * WHY THIS EXISTS
 * Every item picker shows a bounded first page and searches the rest server-side. That is correct
 * for *finding* an item, and useless for *displaying one already chosen*: a form opened on a saved
 * record — or deep-linked with `?item=<id>` — holds an id that the first page very often does not
 * contain. Before this, those forms looked up the id in their loaded page, missed, and rendered an
 * EMPTY picker on a line that was in fact set.
 *
 * It is deliberately a batch: a receipt with twenty lines resolves them in one call rather than
 * twenty. `ids` is sent to the list endpoint, which ANDs it with the caller's normal filters, so
 * this can only ever narrow what the user is allowed to see. Past `MAX_IDS_PER_LOOKUP` the list is
 * split (`chunkIds`) rather than sent whole — one oversized request comes back SHORT, and a short
 * page is indistinguishable from a complete one.
 *
 * Ids are requested at most once each (the ref survives re-renders), so a parent re-rendering on
 * every keystroke does not re-fetch. Failures release their ids rather than leaving them marked as
 * done, and are otherwise swallowed: this is a display nicety, and the surrounding form already
 * reports its own load errors.
 *
 * A RESPONSE IS NEVER DISCARDED, and that is the whole shape of this hook.
 * The obvious `let active = true` / `return () => { active = false }` guard is wrong here, because
 * an effect's cleanup runs on every dependency change, not only on unmount. Ids were marked as
 * requested BEFORE the fetch, so a set that shrank mid-flight — a parent's own catalogue page
 * landing and merging in some of the rows this batch was already fetching — cancelled the batch and
 * left the remaining ids marked forever. They were never asked for again, and their pickers stayed
 * blank on lines that were set: exactly the bug this hook exists to prevent. Merging is by id and
 * idempotent, so a late answer is never harmful; only UNMOUNT cancels, and then only because there
 * is no longer anyone to tell.
 *
 * @returns whether a lookup is still in flight. Callers show "loading" from THIS rather than from
 * "the id isn't in my list yet" — the two differ precisely when a lookup has failed, and a form that
 * infers it says "Loading…" forever over a line it has given up on.
 */
export function useIrmItemsByIds(ids: string[], onResolved: (items: IrmItem[]) => void): boolean {
  // Written only from inside an effect, never during render.
  const requested = React.useRef(new Set<string>());
  const onResolvedRef = React.useRef(onResolved);
  React.useEffect(() => {
    onResolvedRef.current = onResolved;
  });

  // Set in the effect BODY, not just cleared in its cleanup: React remounts an effect without
  // remounting the component (Strict Mode does it on every mount), and a flag only ever cleared
  // would leave a live component permanently unable to accept an answer.
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
      listIrmItems({ ids: batch, pageSize: batch.length }).then(
        (page) => {
          if (mounted.current && page.items.length) onResolvedRef.current(page.items);
          setInFlight((n) => n - 1);
        },
        () => {
          // Released, so a later render that still needs them asks again rather than leaving the id
          // permanently marked as done.
          for (const id of batch) requested.current.delete(id);
          setInFlight((n) => n - 1);
        },
      );
    }
  }, [key]);

  return inFlight > 0;
}
