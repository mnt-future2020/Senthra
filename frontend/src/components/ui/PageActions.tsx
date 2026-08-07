"use client";

import * as React from "react";
import { createPortal } from "react-dom";

/**
 * Page-level NAVIGATION and status chrome, rendered into the TOP BAR beside the page name — a
 * tab-pill switcher (Users / Roles / Departments / Job titles), a "last updated" stamp.
 *
 * Two earlier arrangements were worse: a card carrying a duplicate copy of the page title (~110px of
 * a 768px laptop screen spent restating what the top bar already said), then a slim row of their
 * own, which still cost a full band of the page and left the controls floating in it with nothing on
 * their left. In the top bar they cost no vertical space at all and fill a half that was empty.
 *
 * NOT for action buttons — Export CSV, Submit stock, Move stock. Those went here first and it was
 * wrong: on a wide screen the top bar's right edge is most of a screen away from the rows the button
 * acts on, and it sits close enough to the browser's own chrome to read as part of it. They belong
 * at the right-hand end of the page's own toolbar row (`toolbarActionsCls` + that toolbar's
 * `ml-auto` breakpoint), which already exists and whose right half is empty — so the fix costs no
 * vertical space either. Tabs are different: people scan the top of a page for navigation.
 *
 * The mechanism is a portal into a slot the shell hands down through context — the same
 * callback-ref-plus-portal pattern WarehouseDetail already uses for its filter menu, just via
 * context because the top bar is a SIBLING of the page rather than its parent. Nothing here writes
 * state during render or from an effect.
 *
 * Renders nothing at all when it has no children, so a permission-gated slot that collapses to
 * `false` leaves no stray gap in the top bar.
 *
 *   <PageActions><TabPills … /></PageActions>
 */

/**
 * The element in the top bar that PageActions renders into. Null before the shell's first commit
 * (the ref callback has not run yet) and in any tree rendered outside the dashboard shell.
 */
export const PageActionsSlotContext = React.createContext<HTMLElement | null>(null);

export function PageActions({ children }: { children?: React.ReactNode }) {
  const slot = React.useContext(PageActionsSlotContext);

  // `false` / `null` children are how call sites say "you can't see this" (a single visible tab, a
  // missing permission). Bail before portalling so the slot stays genuinely empty.
  if (!children) return null;

  // No slot means we're outside the shell. Fall back to rendering in place rather than vanishing —
  // a control the user can't reach is worse than one in an unexpected spot.
  if (!slot) return <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>;

  return createPortal(children, slot);
}
