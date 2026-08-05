// What happens to the visible toast stack when a message is pushed onto it.
//
// Extracted from DashboardProvider so the rules are testable: this suite has no DOM renderer, so
// anything left inside the component is only ever verified by clicking around. The provider keeps
// the side effects (timers, React state); this decides WHAT the stack becomes.

export type ToastType = "success" | "info" | "alert";
export type Toast = { id: string; msg: string; type: ToastType; count: number };

// How many toasts may share the screen. Deliberately small: past a handful they stop being
// notifications and become a wall covering the thing they are describing.
export const MAX_TOASTS = 4;

export interface ToastPush {
  /** The stack to render. */
  toasts: Toast[];
  /** Whose dismissal clock to (re)start — a repeat must live from the LATEST occurrence. */
  keepAlive: string;
  /** Ids pushed off the end; their timers must be cancelled or they fire against nothing. */
  dropped: string[];
}

/**
 * Merge a message into the stack.
 *
 * A repeat of something already showing bumps its `count` rather than stacking a duplicate — clicking
 * a copy button nine times produced nine identical toasts that filled the viewport and buried the row
 * they described, and the ninth said nothing the first hadn't. Type is part of the identity: the same
 * text as `success` and as `alert` are different events and must not merge.
 *
 * `nextId` is supplied by the caller so this stays pure (and so ids can stay monotonic — a random id
 * can repeat, and a duplicate React key makes a dismiss remove whichever node it matches first).
 */
export function pushToastStack(
  current: readonly Toast[],
  msg: string,
  type: ToastType,
  nextId: string,
): ToastPush {
  const existing = current.find((t) => t.msg === msg && t.type === type);
  if (existing) {
    return {
      toasts: current.map((t) => (t.id === existing.id ? { ...t, count: t.count + 1 } : t)),
      keepAlive: existing.id,
      dropped: [],
    };
  }
  const withNew: Toast[] = [...current, { id: nextId, msg, type, count: 1 }];
  const toasts = withNew.slice(-MAX_TOASTS);
  return {
    toasts,
    keepAlive: nextId,
    // Oldest first out — the newest describes what the user just did.
    dropped: withNew.slice(0, withNew.length - toasts.length).map((t) => t.id),
  };
}
