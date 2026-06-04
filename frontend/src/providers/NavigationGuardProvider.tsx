"use client";

import * as React from "react";

import { ConfirmDialog } from "@/components/dashboard/users/ConfirmDialog";

// App-level guard against losing unsaved form edits. Any form reports its dirty
// state via useReportDirty(); navigation away (switching Settings sections, the
// sidebar links, or closing/refreshing the tab) is then intercepted and the user
// is asked to confirm before their edits are discarded.
//
// Several forms can be mounted at once (e.g. Account + Security render together),
// so checks are keyed by id and "dirty" means "any mounted form reports dirty".
type GuardContext = {
  register: (id: string, isDirty: () => boolean) => void;
  unregister: (id: string) => void;
  // Are there unsaved edits right now? (Read synchronously by Link guards.)
  anyDirty: () => boolean;
  // Run `proceed` immediately when nothing is dirty; otherwise confirm first and
  // only run it if the user chooses to discard.
  attemptLeave: (proceed: () => void) => void;
};

const NavigationGuardContext = React.createContext<GuardContext | null>(null);

export function NavigationGuardProvider({ children }: { children: React.ReactNode }) {
  const checks = React.useRef<Map<string, () => boolean>>(new Map());
  // The pending navigation, held while the confirm dialog is open. Stored as a
  // thunk (() => fn) so React doesn't treat the function as a state updater.
  const [pending, setPending] = React.useState<(() => void) | null>(null);

  const anyDirty = React.useCallback(
    () => [...checks.current.values()].some((isDirty) => isDirty()),
    [],
  );

  const attemptLeave = React.useCallback(
    (proceed: () => void) => {
      if (anyDirty()) setPending(() => proceed);
      else proceed();
    },
    [anyDirty],
  );

  const value = React.useMemo<GuardContext>(
    () => ({
      register: (id, isDirty) => {
        checks.current.set(id, isDirty);
      },
      unregister: (id) => {
        checks.current.delete(id);
      },
      anyDirty,
      attemptLeave,
    }),
    [anyDirty, attemptLeave],
  );

  // Warn on tab close / refresh / hard navigation while anything is dirty.
  React.useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!anyDirty()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyDirty]);

  const confirmDiscard = () => {
    pending?.();
    setPending(null);
  };

  return (
    <NavigationGuardContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        title="Discard unsaved changes?"
        message="You have unsaved changes. If you leave now, they will be lost."
        confirmLabel="Discard changes"
        danger
        onConfirm={confirmDiscard}
        onClose={() => setPending(null)}
      />
    </NavigationGuardContext.Provider>
  );
}

// For navigators (sidebar, section switcher): read dirty state + gate navigation.
export function useNavigationGuard(): GuardContext {
  const ctx = React.useContext(NavigationGuardContext);
  if (!ctx) {
    throw new Error("useNavigationGuard must be used within a NavigationGuardProvider");
  }
  return ctx;
}

// For forms: report live dirty state into the guard. Re-registers a fresh getter
// only when the flag flips (it's a boolean), so this doesn't churn on keystrokes.
export function useReportDirty(id: string, isDirty: boolean): void {
  const ctx = React.useContext(NavigationGuardContext);

  React.useEffect(() => {
    if (!ctx) return;
    ctx.register(id, () => isDirty);
    return () => ctx.unregister(id);
  }, [id, ctx, isDirty]);
}
