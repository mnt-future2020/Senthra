"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { MapPin, Search, X } from "lucide-react";

import { anchorMoved, anchorVisible, popoverPlacement, type Placement } from "./popoverPlacement";
import { toolbarInputCls } from "./styles";

// ── The SITE filter's picker ───────────────────────────────────────────────────────────────────
//
// A TYPE-AHEAD, not a dropdown, and that is the whole reason this component exists.
//
// Sites belong to a customer and arrive by bulk import — a single account routinely holds thousands.
// Every other id filter in this app is a `<Select>` fed by one 200-row fetch, and that ceiling is
// fine for warehouses, suppliers and engineers because those sets are genuinely small. Point it at
// sites and it silently truncates: the list shows the first 200 alphabetically and the site somebody
// is looking for is simply absent, with nothing on screen saying so. A filter that quietly omits the
// thing you are filtering for is worse than no filter at all.
//
// So the options are SEARCHED server-side, capped, and the control shows what it is showing. When
// the caller passes `customerId` the search is narrowed to that company — which is also what makes
// the portal's copy of this safe, since there the id comes from the session.

export interface SiteOptionLike {
  id: string;
  name: string;
  code: string | null;
  postcode: string | null;
  customerName?: string | null;
}

export interface SitePickerProps {
  /** The selected site id, or "" for none. */
  value: string;
  /**
   * The chosen site. The OPTION comes back too — the caller has to remember its label, because a
   * search result is not a complete set and a selected id cannot be looked up in it afterwards.
   */
  onChange: (siteId: string, option?: SiteOptionLike) => void;
  /** Runs the server-side search. Debounced by this component; may reject (treated as no results). */
  search: (term: string) => Promise<SiteOptionLike[]>;
  /**
   * Label for the CURRENT selection. Needed because a selected id alone cannot be rendered — the
   * option list is a search result, not a complete set, so there is nothing to look the id up in.
   */
  selectedLabel?: string | null;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

/** Panel size, in px — see FilterPopover for why it is declared rather than measured. PANEL_H is the
 *  cap the panel wants; popoverPlacement hands back the smaller of it and the room the chosen side
 *  had, and the panel wears that as an inline `max-height`. The only place the height is written. */
const PANEL_W = 300;
const PANEL_H = 320;
/** Long enough that typing a site name is one request, short enough to feel immediate. */
const DEBOUNCE_MS = 250;

/** The string an option shows — exported so a caller can store it as the trigger label. */
export const siteOptionLabel = (s: SiteOptionLike): string => (s.code ? `${s.code} — ${s.name}` : s.name);
const optionHint = (s: SiteOptionLike): string =>
  [s.postcode, s.customerName].filter(Boolean).join(" · ");

export function SitePicker({
  value,
  onChange,
  search,
  selectedLabel,
  placeholder = "All sites",
  disabled,
  ariaLabel = "Filter by site",
}: SitePickerProps) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<Placement | null>(null);
  const [term, setTerm] = React.useState("");
  // `null` means "nothing fetched for this term yet", which IS the loading state — so it is derived
  // rather than a second flag set synchronously in the effect (a cascading render the React-Compiler
  // lint rejects). Cleared when the term changes so the panel says "Searching…" again.
  const [options, setOptions] = React.useState<SiteOptionLike[] | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const anchorRef = React.useRef<DOMRect | null>(null);

  // Adjusted DURING RENDER, not in an effect: a new term invalidates the shown options immediately,
  // so the panel reads "Searching…" instead of showing the previous term's matches under the new one.
  const [prevTerm, setPrevTerm] = React.useState(term);
  if (prevTerm !== term) {
    setPrevTerm(term);
    setOptions(null);
  }

  const close = React.useCallback(() => {
    setOpen(false);
    btnRef.current?.focus();
  }, []);

  const openPanel = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    anchorRef.current = rect;
    setPos(popoverPlacement(rect, { width: PANEL_W, height: PANEL_H }, { width: window.innerWidth, height: window.innerHeight }));
    setOpen(true);
  };

  // Debounced search, re-run whenever the panel opens so it always offers SOMETHING to pick from
  // rather than an empty box that only fills once you type.
  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    const t = setTimeout(() => {
      search(term)
        .then((rows) => { if (alive) setOptions(rows); })
        // An empty list, never a broken control: the caller may lack the permission that backs the
        // lookup, and a picker that throws is worse than one that says it found nothing.
        .catch(() => { if (alive) setOptions([]); });
    }, DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(t); };
  }, [open, term, search]);

  // Same anchor-following rule as FilterPopover: reposition while the trigger is on screen, dismiss
  // only when it leaves. A containment check cannot work here — the panel is portalled to <body>.
  React.useEffect(() => {
    if (!open) return;
    const onMove = () => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (!anchorVisible(rect, { height: window.innerHeight })) { setOpen(false); return; }
      if (!anchorMoved(anchorRef.current ?? rect, rect)) return;
      anchorRef.current = rect;
      setPos(popoverPlacement(rect, { width: PANEL_W, height: PANEL_H }, { width: window.innerWidth, height: window.innerHeight }));
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("keydown", onKey);
    // preventScroll — see FilterPopover: the panel is capped to the room its side had, and focusing
    // the search box would scroll the panel's own header out of its top on a short window.
    panelRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const pick = (id: string, option?: SiteOptionLike) => {
    onChange(id, option);
    setOpen(false);
  };

  const label = value ? (selectedLabel ?? "Site selected") : placeholder;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : openPanel())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2.5 text-xs font-bold transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
          value
            ? "border-[var(--accent)] bg-[var(--accent-10)] text-[var(--accent)]"
            : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)]"
        }`}
      >
        <MapPin aria-hidden className="h-3.5 w-3.5" />
        <span className="max-w-[11rem] truncate">{label}</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[55]" onClick={close} />
            <div
              ref={panelRef}
              role="dialog"
              aria-label={ariaLabel}
              /* The height cap arrives on `pos` — the room this side actually had, capped at PANEL_H.
                 Still a flex column: the search box stays put and the list below it takes the rest. */
              className="anim-fade-in fixed z-[60] flex w-[300px] flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-2xl"
              style={pos}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Site</span>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close site filter"
                  className="rounded p-0.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="relative shrink-0">
                <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--faint)]" />
                <input
                  type="search"
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  placeholder="Search name, code or postcode…"
                  aria-label="Search sites"
                  className={`${toolbarInputCls} pl-8`}
                />
              </div>
              <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
                {/* "Any site" first and always present, so clearing the filter never depends on the
                    search finding anything. */}
                <button
                  type="button"
                  onClick={() => pick("")}
                  className={`w-full rounded-lg px-2 py-1.5 text-left text-xs font-semibold transition-colors hover:bg-[var(--surface-2)] ${
                    value ? "text-[var(--muted)]" : "text-[var(--accent)]"
                  }`}
                >
                  All sites
                </button>
                {options === null ? (
                  <p className="px-2 py-3 text-[11px] text-[var(--faint)]">Searching…</p>
                ) : options && options.length === 0 ? (
                  <p className="px-2 py-3 text-[11px] text-[var(--faint)]">
                    {term ? "No sites match that." : "No sites to show."}
                  </p>
                ) : (
                  (options ?? []).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => pick(s.id, s)}
                      className={`w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-2)] ${
                        s.id === value ? "bg-[var(--accent-10)]" : ""
                      }`}
                    >
                      <span className="block truncate text-xs font-semibold text-[var(--ink)]">{siteOptionLabel(s)}</span>
                      {optionHint(s) && (
                        <span className="block truncate text-[10px] text-[var(--faint)]">{optionHint(s)}</span>
                      )}
                    </button>
                  ))
                )}
                {/* The cap is STATED rather than hidden. A truncated option list that looks complete
                    is the exact failure this control was built to avoid. */}
                {options && options.length >= 50 && (
                  <p className="px-2 py-2 text-[10px] leading-snug text-[var(--faint)]">
                    Showing the first 50 matches — type more to narrow.
                  </p>
                )}
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
