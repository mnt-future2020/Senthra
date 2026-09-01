"use client";

import * as React from "react";
import { createPortal } from "react-dom";

import { IrmItemForm } from "./IrmItemForm";
import type { IrmItem } from "@/types/irm";

/**
 * Hosts the REAL Add IRM item form over whatever document needed the item.
 *
 * WHY AN OVERLAY RATHER THAN A ROUTE
 * Sending the user to `/dashboard/irm/new` would unmount the form they came from. A purchase
 * request holds everything typed into it in memory — supplier, terms, notes, every item and rental
 * line, and a quote file that cannot be serialised anywhere at all — so navigating away destroys
 * it. That is what the app's NavigationGuard exists to prevent, and no draft-persistence scheme can
 * carry a `File` through a route change. Rendering over the top keeps the caller mounted and
 * untouched, and costs the user nothing: it is the same component the route renders.
 *
 * WHY NOT `Modal`
 * That shell caps at `max-w-lg`, which would squeeze a seven-section, three-column form into a
 * phone-width column. This deliberately reproduces the dashboard's own content frame instead —
 * `overflow-y-auto p-4 md:p-8`, matching DashboardShell — so the form gets the full page width and
 * `FormPageHeader`'s sticky negative margins line up exactly as they do on the route. The layout
 * inside is the page's own and is therefore responsive by the same rules, at every breakpoint.
 *
 * STACKING: z-40 sits above the shell and its mobile sidebar backdrop (z-30) and below everything
 * the form itself opens — Modal (z-50), ConfirmDialog (z-60), Select's portalled menu (z-80) and
 * toasts (z-99) all remain on top and clickable.
 */
export function IrmItemCreateOverlay({
  initialName,
  initialSupplierId,
  onCreated,
  onClose,
}: {
  initialName: string;
  initialSupplierId?: string;
  onCreated: (created: IrmItem) => void;
  onClose: () => void;
}) {
  // Hold the page still underneath. Without it the body scrolls behind the overlay on wheel/touch,
  // and returning leaves the caller scrolled somewhere the user never went.
  React.useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (typeof document === "undefined") return null;

  // Portalled to <body> for the same reason Modal is: `fixed` measured against the viewport rather
  // than a transformed ancestor.
  //
  // It does NOT put this form outside the caller's <form> as far as events are concerned. React
  // dispatches along the REACT tree, not the DOM tree, so the portal moves the markup and leaves the
  // event path exactly where it was — which is why the wrapper below has to stop it explicitly.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add IRM item"
      // The portal above keeps this overlay out of the page's DOM — but React events do NOT follow the
      // DOM tree, they follow the REACT tree. So the form inside still bubbles its submit (and reset)
      // straight up to whatever page <form> the picker was DECLARED inside, running that page's submit
      // handler. Opening this from the New Purchase Request form and clicking "Create item" therefore
      // ALSO submitted the purchase request — saving and navigating away while the item was still
      // being created.
      //
      // Same guard, same place, same reason as Modal.tsx and ConfirmDialog.tsx: stopped on the
      // OUTERMOST node of the portalled subtree, so the inner form's own handlers (which sit deeper)
      // have already run and still work normally. `preventDefault` is NOT a substitute — that only
      // suppresses the browser's navigation, not the propagation that reaches the parent form.
      onSubmit={(e) => e.stopPropagation()}
      onReset={(e) => e.stopPropagation()}
      // Opaque, not a scrim: this is a full working surface, and a form read through a translucent
      // panel over a busy page is unreadable.
      className="fixed inset-0 z-40 w-full overflow-y-auto bg-[var(--bg)] p-4 md:p-8"
    >
      <IrmItemForm
        mode="create"
        initialName={initialName}
        initialSupplierId={initialSupplierId}
        onCreated={onCreated}
        onCancel={onClose}
      />
    </div>,
    document.body,
  );
}
