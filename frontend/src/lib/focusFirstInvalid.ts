/**
 * Move focus to the first control a failed submit marked invalid.
 *
 * WHY THIS EXISTS
 * The forms in this app set `aria-invalid` on the offending fields and (most of them) raise a
 * "Please fix the highlighted fields." toast. Neither puts the field on screen. The full-page forms
 * carry their Save button in a STICKY header (see FormPageHeader), so the usual failure is: fill a
 * long form, scroll to the bottom, press Save, and get a toast about highlights that are hundreds of
 * pixels above. Modals with a scrolling body fail the same way in miniature.
 *
 * Focusing the field solves all of it at once — it scrolls into view, the caret lands where the fix
 * has to be typed, and screen readers announce the field together with its `aria-describedby` error.
 *
 * NO UNIT TEST: this is DOM-only glue and `jsdom` is not a dependency of this project (the vitest
 * config runs in Node). Everything it does is a no-op when nothing matches, so the failure mode is
 * "behaves exactly as before", not a crash.
 */

/** How the scroll should land the field — `center` keeps it clear of the sticky form header. */
const SCROLL_BLOCK: ScrollLogicalPosition = "center";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * What counts as "the thing that failed".
 *
 * `aria-invalid="true"` is the normal case — a control the submit marked bad. `data-invalid="true"`
 * covers problems that belong to a SECTION rather than a single control: a purchase order with no
 * lines, a receipt whose line table doesn't add up. Those render their message under a table, and
 * there is no input to put a red ring on — so without a marker the submit set an error, raised a
 * toast, and moved nothing, which reads exactly like the button being broken.
 *
 * Both are handled by the same call: a non-focusable marker simply scrolls (calling `focus()` on an
 * element that can't take focus is a documented no-op, so no branch is needed).
 */
const INVALID_SELECTOR = '[aria-invalid="true"],[data-invalid="true"]';

/**
 * Scope the search to the topmost open dialog when there is one.
 *
 * A modal form's invalid field MUST win over a page form sitting behind it — otherwise submitting
 * inside a modal could yank focus to a stale highlight on the page underneath, which both scrolls
 * the wrong thing and breaks the modal's focus trap. `Modal` and `ConfirmDialog` both render
 * `role="dialog"`, and the last one in document order is the one on top.
 */
function searchScope(): ParentNode {
  if (typeof document === "undefined") return { querySelector: () => null } as unknown as ParentNode;
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
  return dialogs.length > 0 ? dialogs[dialogs.length - 1] : document;
}

/**
 * Call immediately after `setErrors(...)` on a rejected submit.
 *
 * Deferred to the next frame because `aria-invalid` is applied by the render that `setErrors`
 * schedules — querying synchronously would read the DOM as it was before the failure and find
 * nothing (or worse, the previous attempt's highlight).
 */
export function focusFirstInvalid(): void {
  if (typeof window === "undefined") return; // SSR / non-browser: nothing to focus
  window.requestAnimationFrame(() => {
    // First match in DOCUMENT order across both markers — i.e. the topmost problem on the form,
    // which is the one to take the user to.
    const el = searchScope().querySelector<HTMLElement>(INVALID_SELECTOR);
    if (!el) return;
    // `preventScroll` then an explicit scroll: the browser's own focus scrolling uses `nearest`,
    // which is happy to stop with the field tucked under the sticky header it just scrolled past.
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: SCROLL_BLOCK, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  });
}
