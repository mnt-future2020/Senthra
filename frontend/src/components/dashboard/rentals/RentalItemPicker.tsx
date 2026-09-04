"use client";

import * as React from "react";
import { AlertTriangle, Check, ChevronDown, Loader2, PackagePlus, Search } from "lucide-react";

import { listRentalItems } from "@/services/rental.service";
import { dropdownRadius, dropdownSurfaceCls, inputCls } from "@/components/ui/styles";
import {
  CATALOGUE_MIN_QUERY,
  catalogueSearchView,
  matchesAnyField,
  shouldOfferCreate,
  type SettledSearch,
} from "@/lib/cataloguePicker";
import type { RentalItem } from "@/types/rental";
import { RentalItemCreateOverlay } from "./RentalItemCreateOverlay";

/** Long enough that a normal typist fires one request per word, short enough to feel live. */
const DEBOUNCE_MS = 250;
/** A picker is for recognising, not browsing — past this many hits the answer is a better query. */
const SEARCH_PAGE_SIZE = 25;

/** The three fields the server searches (`findMany` in rental-item.repository.ts). */
const matchesRentalQuery = (item: RentalItem, query: string): boolean =>
  matchesAnyField([item.name, item.code, item.description], query);

const rentalItemLabel = (item: Pick<RentalItem, "name" | "code">): string => `${item.name} (${item.code})`;

/**
 * Pick a rental catalogue item — searching the WHOLE catalogue, and creating the item if it is not
 * there yet.
 *
 * It replaces a plain `<Select>` fed by a `pageSize: 100` load. That cap was not a styling detail:
 * past a hundred active rental items the hundred-and-first simply had no row in the dropdown, with
 * no error and nothing on screen to suggest anything was missing — so a hire that already existed
 * looked absent and got created a second time.
 *
 * The search state machine and the create-offer rule come from `lib/cataloguePicker`, shared with
 * the IRM picker: the rule for when it is SAFE to invite a new catalogue entry is subtle, and a
 * second copy of it would drift.
 */
export function RentalItemPicker({
  value,
  selectedItem,
  seed = [],
  onSelect,
  canCreate,
  disabled,
  loading,
  ariaLabel = "Rental item",
  invalid,
}: {
  /** Selected item id, or "" for none. */
  value: string;
  /**
   * The selected item, for the closed label — it may be in neither `seed` nor the current results.
   * Narrowed to the fields the label needs so a caller can fall back to the reference a saved
   * record carries when the full catalogue row is not loaded.
   */
  selectedItem: Pick<RentalItem, "id" | "name" | "code"> | null;
  /** The caller's already-loaded page, listed before anything is typed so the menu is never blank. */
  seed?: RentalItem[];
  onSelect: (item: RentalItem) => void;
  /** `rentals.create` — without it no create affordance is rendered at all. */
  canCreate: boolean;
  disabled?: boolean;
  /** The caller's reference data is still loading, so `seed` is not yet meaningful. */
  loading?: boolean;
  ariaLabel?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  /**
   * The last SETTLED search, tagged with the query it answers. One state keyed by its query rather
   * than a `results` + `searching` + `failed` trio — that trio needs a synchronous setState in the
   * effect body, which the React Compiler rules reject, and it can disagree with itself for a frame.
   */
  const [settled, setSettled] = React.useState<SettledSearch<RentalItem> | null>(null);
  // Non-null while the create overlay is up; holds the name it was opened with. Captured at open
  // time so closing the dropdown (which clears `query`) cannot blank the form's name field.
  const [createName, setCreateName] = React.useState<string | null>(null);

  const wrapRef = React.useRef<HTMLDivElement>(null);
  // Every search run takes a ticket, so a slow "cat" answering after a fast "cat6" is dropped.
  const seqRef = React.useRef(0);
  const listboxId = React.useId();

  const q = query.trim();
  const isSearchQuery = q.length >= CATALOGUE_MIN_QUERY;

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
      listRentalItems({ search: q, status: "active", pageSize: SEARCH_PAGE_SIZE }).then(
        (page) => {
          if (seq === seqRef.current) setSettled({ query: q, items: page.items, failed: false });
        },
        () => {
          // Deliberately NOT toasted: this re-runs per keystroke, and a failing connection would
          // stack a toast per letter. The message goes in the menu, where the user is looking.
          if (seq === seqRef.current) setSettled({ query: q, items: [], failed: true });
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, isSearchQuery, q]);

  const { options, searching, searchFailed, matchCount } = catalogueSearchView(query, settled, seed, matchesRentalQuery);
  // Clamped rather than reset in an effect: results arrive asynchronously and the highlight has to
  // stay inside the list on the very render that shrinks it.
  const active = options.length > 0 ? Math.min(activeIndex, options.length - 1) : -1;

  // matchCount rather than options.length — see the IRM picker. This picker takes no `filterItem`
  // today, so the two are equal; using matchCount means adding one can never quietly start inviting
  // duplicates of rows that were merely filtered out.
  const offerCreate = shouldOfferCreate({ canCreate, query, searching, searchFailed, resultCount: matchCount });

  const commit = (item: RentalItem) => {
    onSelect(item);
    setOpen(false);
    setQuery("");
  };

  const openCreate = () => {
    setCreateName(q);
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
      else if (offerCreate) openCreate();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setQuery("");
    }
  };

  const placeholder = loading && !value ? "Loading rental items…" : "— Select a rental item —";

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
          className={`${inputCls} flex items-center justify-between gap-2 text-left`}
        >
          <span className={`truncate ${selectedItem ? "text-[var(--ink)]" : "text-[var(--faint)]"}`}>
            {selectedItem ? rentalItemLabel(selectedItem) : placeholder}
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
                  placeholder="Search by name, code or description…"
                  aria-label="Search the rental catalogue"
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2 pl-8 pr-8 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                />
                {searching && (
                  <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-[var(--faint)]" />
                )}
              </div>
            </div>

            <ul id={listboxId} role="listbox" aria-label={ariaLabel} className="max-h-64 overflow-auto py-1">
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
                        {item.baseUnit ? ` · ${item.baseUnit}` : ""}
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
                    Couldn&apos;t search the rental catalogue. Check your connection and try again —
                    until it answers there&apos;s no way to tell whether this item already exists.
                  </span>
                </li>
              )}

              {options.length === 0 && !searching && !searchFailed && (
                <li className="px-3 py-3 text-center text-xs text-[var(--muted)]">
                  {isSearchQuery ? "No matching rental item." : "No rental items to show."}
                </li>
              )}
            </ul>

            {offerCreate && (
              <div className="border-t border-[var(--border-2)] p-1">
                <button
                  type="button"
                  onClick={openCreate}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-semibold text-[var(--accent)] transition-colors hover:bg-[var(--accent-10)]"
                >
                  <PackagePlus className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">Add &ldquo;{q}&rdquo; as a new rental item</span>
                </button>
              </div>
            )}

            {/* Said only before a search: the list on screen is the caller's mount-time page, not the
                catalogue. Without this the first screenful reads as "all we have". */}
            {!isSearchQuery && !loading && (
              <p className="border-t border-[var(--border-2)] px-3 py-2 text-[11px] text-[var(--faint)]">
                Type to search the whole rental catalogue.
              </p>
            )}
          </div>
        )}
      </div>

      {createName !== null && (
        <RentalItemCreateOverlay
          initialName={createName}
          onClose={() => setCreateName(null)}
          onCreated={(item) => {
            setCreateName(null);
            commit(item);
          }}
        />
      )}
    </>
  );
}
