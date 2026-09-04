"use client";

import * as React from "react";
import { AlertTriangle, Check, ChevronDown, Loader2, PackagePlus, Search } from "lucide-react";

import { listIrmItems } from "@/services/irm.service";
import { dropdownRadius, dropdownSurfaceCls, inputCls, toolbarInputCls } from "@/components/ui/styles";
import type { IrmItem } from "@/types/irm";
import { IrmItemCreateOverlay } from "./IrmItemCreateOverlay";
import {
  irmItemLabel,
  QUICK_CREATE_MIN_QUERY,
  searchView,
  shouldOfferQuickCreate,
  type SettledSearch,
} from "./irmItemPickerModel";

/** Long enough that a normal typist fires one request per word, short enough to feel live. */
const DEBOUNCE_MS = 250;
/** A picker is for recognising, not browsing — past this many hits the answer is a better query. */
const SEARCH_PAGE_SIZE = 25;

/**
 * Pick an IRM catalogue item — searching the WHOLE catalogue, and creating the item if it isn't
 * there yet.
 *
 * It replaces a plain `<Select>` fed by a `pageSize: 100` load. That cap was not a styling detail:
 * past a hundred active items the hundred-and-first simply had no row in the dropdown, with no
 * error and nothing on screen to suggest anything was missing. Searching server-side removes the
 * ceiling, and it is also what makes the create option safe to offer — see `shouldOfferQuickCreate`.
 *
 * The full `IrmItem` is handed back to `onSelect`, not just its id, because the caller needs the
 * cost, VAT and pack size to prefill its line and must fold the item into whatever list it looks
 * those up in — a search result won't be in the list it loaded at mount.
 */
export function IrmItemPicker({
  value,
  selectedItem,
  seed = [],
  onSelect,
  canCreate,
  filterItem,
  defaultSupplierId,
  disabled,
  loading,
  ariaLabel = "Item",
  invalid,
  size = "default",
  onClear,
}: {
  /** Selected item id, or "" for none. */
  value: string;
  /**
   * The selected item, for the closed label — it may be in neither `seed` nor the current results.
   * Narrowed to the three fields the label needs so a caller can fall back to the reference a saved
   * record carries (a PRF line's `irmItem`) when the full catalogue row isn't loaded.
   */
  selectedItem: Pick<IrmItem, "id" | "name" | "code"> | null;
  /**
   * The caller's already-loaded items, listed before anything is typed so the menu is never blank.
   * Optional: a caller with nothing preloaded shows an empty menu that says to type, which is
   * honest — and far better than every row of a multi-line form firing its own catalogue fetch.
   */
  seed?: IrmItem[];
  onSelect: (item: IrmItem) => void;
  /** `irm.create` — without it no create affordance is rendered at all. */
  canCreate: boolean;
  /**
   * The caller's own domain rule for what may be picked here (stock adjustment, for one, only
   * handles items that are neither serial- nor batch-tracked). Applied to the seed AND to search
   * results; excluded matches are reported to the user rather than silently vanishing.
   */
  filterItem?: (item: IrmItem) => boolean;
  /** Supplier the calling form is already about; seeds the new item's supplier link. */
  defaultSupplierId?: string;
  disabled?: boolean;
  /** The caller's reference data is still loading, so `seed` is not yet meaningful. */
  loading?: boolean;
  ariaLabel?: string;
  invalid?: boolean;
  /**
   * "sm" puts the trigger in the compact LIST-TOOLBAR family (see styles.ts) instead of the form
   * family — a form-sized control next to `<Select size="sm">` sits visibly taller and rounder.
   */
  size?: "default" | "sm";
  /**
   * Offered as an "All items" row at the top of the menu. Only for FILTERS, where "no item" is a
   * real answer; a required form field has nothing to clear to.
   */
  onClear?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  /**
   * The last SETTLED search, tagged with the query it answers.
   *
   * One state keyed by its query rather than the obvious `results` + `searching` + `failed` trio.
   * That trio needs a synchronous `setSearching(true)` in the effect body — a cascading render the
   * React Compiler rules reject — and it can also disagree with itself for a frame. Here every
   * derived flag below is a comparison against the query on screen, so "still searching" is simply
   * "this answer isn't for what you've typed", which is true through the debounce as well as the
   * request, and an out-of-order response is ignored by construction.
   */
  const [settled, setSettled] = React.useState<SettledSearch | null>(null);
  // Non-null while the quick-create dialog is up; holds the name it was opened with. Captured at
  // open time so closing the dropdown (which clears `query`) can't blank the dialog's name field.
  const [quickName, setQuickName] = React.useState<string | null>(null);

  const wrapRef = React.useRef<HTMLDivElement>(null);
  // Every search run takes a ticket. A response holding a stale ticket is dropped, so a slow
  // "cat" answering after a fast "cat6" can't repaint the list with the wrong results.
  const seqRef = React.useRef(0);
  const listboxId = React.useId();

  const q = query.trim();
  const isSearchQuery = q.length >= QUICK_CREATE_MIN_QUERY;

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  React.useEffect(() => {
    if (!open || !isSearchQuery) return;
    // Taken before the debounce, not inside it, so a newer keystroke invalidates an in-flight
    // response even when this run's own request is never fired.
    const seq = ++seqRef.current;
    const timer = setTimeout(() => {
      listIrmItems({ search: q, status: "active", pageSize: SEARCH_PAGE_SIZE }).then(
        (page) => {
          if (seq === seqRef.current) setSettled({ query: q, items: page.items, failed: false });
        },
        () => {
          // Deliberately NOT toasted: this re-runs per keystroke, and a failing connection would
          // stack a toast for every letter. The message goes in the menu, where the user is looking.
          if (seq === seqRef.current) setSettled({ query: q, items: [], failed: true });
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, isSearchQuery, q]);

  const { options, searching, searchFailed, excludedCount, matchCount } = searchView(query, settled, seed, filterItem);
  // Clamped rather than reset in an effect: results arrive asynchronously and the highlight has to
  // stay inside the list on the very render that shrinks it.
  const active = options.length > 0 ? Math.min(activeIndex, options.length - 1) : -1;

  const offerCreate = shouldOfferQuickCreate({
    canCreate,
    query,
    searching,
    searchFailed,
    // matchCount, NOT options.length: a row this screen's own rule excluded still EXISTS. Counting
    // only the visible ones would offer "create" for an item the catalogue already holds.
    resultCount: matchCount,
  });

  const commit = (item: IrmItem) => {
    onSelect(item);
    setOpen(false);
    setQuery("");
  };

  const openQuickCreate = () => {
    setQuickName(q);
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (options.length === 0 ? 0 : Math.min(i + 1, options.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) commit(options[active]);
      else if (offerCreate) openQuickCreate();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setQuery("");
    }
  };

  const placeholder = loading && !value ? "Loading items…" : "— Select an item —";

  return (
    <>
      <div className="relative" ref={wrapRef}>
        <button
          type="button"
          role="combobox"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          className={`${size === "sm" ? toolbarInputCls : inputCls} flex items-center justify-between gap-2 text-left`}
        >
          <span className={`truncate ${selectedItem ? "text-[var(--ink)]" : "text-[var(--faint)]"}`}>
            {selectedItem ? irmItemLabel(selectedItem) : placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--faint)]" />
        </button>

        {open && !disabled && (
          <div className={`absolute z-30 mt-1 w-full overflow-hidden ${dropdownSurfaceCls}`} style={dropdownRadius}>
            <div className="border-b border-[var(--border-2)] p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--faint)]" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActiveIndex(0);
                  }}
                  onKeyDown={onKeyDown}
                  placeholder="Search by name, code, SKU, brand…"
                  aria-label="Search the item catalogue"
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2 pl-8 pr-8 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                />
                {searching && (
                  <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-[var(--faint)]" />
                )}
              </div>
            </div>

            <ul id={listboxId} role="listbox" aria-label={ariaLabel} className="max-h-64 overflow-auto py-1">
              {onClear && (
                <li role="option" aria-selected={!value}>
                  <button
                    type="button"
                    onClick={() => { onClear(); setOpen(false); setQuery(""); }}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-[var(--muted)] hover:bg-[var(--surface-2)]"
                  >
                    All items
                    {!value && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />}
                  </button>
                </li>
              )}
              {options.map((item, idx) => (
                <li key={item.id} role="option" aria-selected={item.id === value}>
                  <button
                    type="button"
                    onClick={() => commit(item)}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-[var(--ink)] ${
                      idx === active ? "bg-[var(--surface-2)]" : ""
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{item.name}</span>
                      <span className="block truncate text-[11px] text-[var(--muted)]">
                        {item.code}
                        {item.sku ? ` · ${item.sku}` : ""}
                      </span>
                    </span>
                    {item.id === value && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />}
                  </button>
                </li>
              ))}

              {options.length === 0 && searching && (
                <li className="px-3 py-3 text-center text-xs text-[var(--muted)]">Searching…</li>
              )}

              {/* A failed lookup is reported as a failure, never as "no match" — the difference is
                  the whole reason the create option stays hidden here. */}
              {searchFailed && (
                <li className="flex items-start gap-2 px-3 py-3 text-xs text-[var(--muted)]">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                  <span>
                    Couldn&apos;t search the catalogue. Check your connection and try again — until it
                    answers there&apos;s no way to tell whether this item already exists.
                  </span>
                </li>
              )}

              {options.length === 0 && !searching && !searchFailed && (
                <li className="px-3 py-3 text-center text-xs text-[var(--muted)]">
                  {/* An excluded match is NOT a missing item. Saying "no matching item" over a row
                      that exists but this screen can't use is how someone creates a duplicate of it. */}
                  {excludedCount > 0
                    ? `${excludedCount} matching ${excludedCount === 1 ? "item isn't" : "items aren't"} available on this screen.`
                    : isSearchQuery
                      ? "No matching item."
                      : "No items to show."}
                </li>
              )}
            </ul>

            {offerCreate && (
              <div className="border-t border-[var(--border-2)] p-1">
                <button
                  type="button"
                  onClick={openQuickCreate}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-semibold text-[var(--accent)] transition-colors hover:bg-[var(--accent-10)]"
                >
                  <PackagePlus className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">Add &ldquo;{q}&rdquo; as a new IRM item</span>
                </button>
              </div>
            )}

            {/* Said only before a search: the list on screen is the caller's mount-time page, not the
                catalogue. Without this the first screenful reads as "all we have". */}
            {!isSearchQuery && !loading && (
              <p className="border-t border-[var(--border-2)] px-3 py-2 text-[11px] text-[var(--faint)]">
                Type to search the whole catalogue.
              </p>
            )}
          </div>
        )}
      </div>

      {quickName !== null && (
        <IrmItemCreateOverlay
          initialName={quickName}
          initialSupplierId={defaultSupplierId}
          onClose={() => setQuickName(null)}
          onCreated={(item) => {
            setQuickName(null);
            commit(item);
          }}
        />
      )}
    </>
  );
}
