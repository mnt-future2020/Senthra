"use client";

import * as React from "react";

import { getDocumentScrollLock } from "@/components/ui/scrollLock";

/**
 * Hold the page still for as long as `active` is true.
 *
 * Mounted on the SHARED overlay primitives — Modal, ConfirmDialog, ImageLightbox, AuditEntryDrawer
 * and the shell's mobile sidebar — rather than on each of the ~60 dialogs in the app, all of which
 * reach the screen through one of those five. See scrollLock.ts for what the lock does and why the
 * counter is load-bearing.
 *
 * The effect depends only on `active`, so an overlay that re-renders while open (a `busy` flag
 * flipping mid-request) does not release and re-take the lock and flicker the scrollbar.
 */
export function useScrollLock(active: boolean): void {
  React.useEffect(() => {
    if (!active) return;
    const lock = getDocumentScrollLock();
    lock.acquire();
    return () => lock.release();
  }, [active]);
}
