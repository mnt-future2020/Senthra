// Shared Tailwind class strings for forms across the dashboard.
export const inputCls =
  "w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none transition-all placeholder:text-[var(--faint)] focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-[var(--neg)] aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-[var(--neg)]/20";

export const labelCls =
  "mb-1.5 block text-xs font-bold uppercase tracking-wider text-[var(--muted)]";

// Helper text shown under a field to describe what it's for.
export const hintCls = "mt-1.5 text-[11px] leading-snug text-[var(--faint)]";

export const primaryBtn =
  "flex items-center gap-2 rounded-xl bg-[var(--accent)] px-5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60";

// Danger button — same shape as primary, red fill. For confirming a DESTRUCTIVE action (decline,
// delete). Signals the action's severity so it never reads the same as a positive primary.
export const dangerBtn =
  "flex items-center gap-2 rounded-xl bg-[var(--neg)] px-5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60";

// Secondary / outline button used for inline actions (upload, copy, etc.).
export const ghostBtn =
  "flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-60";

// Secondary button sized to sit beside primaryBtn (same height/radius) — e.g. a
// Cancel/Discard next to Save. Outline style so the primary stays the clear default.
export const secondaryBtn =
  "flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-5 py-2.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-60";

/**
 * The SURFACE every dropdown popup is drawn on — `Select`'s listbox, `MultiSelect`, `CreatableSelect`,
 * `SuggestInput`, the item pickers, the comboboxes and the row action menus.
 *
 * The RADIUS is the reason this is named. It has to be an inline style rather than a class, because
 * `var(--radius)` is the user's Appearance → Corner radius setting and Tailwind's `rounded-*` scale
 * cannot read it. Six popups had `rounded-xl` hardcoded and sat frozen at 12px while the Select
 * beside them moved between 6px and 26px — two dropdowns on one screen, opened a second apart, with
 * visibly different corners.
 *
 * Only the surface lives here. Positioning, width, padding and z-index stay at the CALL SITE: a
 * full-width combobox list and a right-aligned action menu share this shell and nothing else.
 */
export const dropdownSurfaceCls = "border border-[var(--border)] bg-[var(--surface)] shadow-2xl";

/** Pair with `dropdownSurfaceCls` — `style={dropdownRadius}`. */
export const dropdownRadius = { borderRadius: "var(--radius)" } as const;

// ── List-toolbar controls ─────────────────────────────────────────────────────────────────────
// The compact family that sits in a list/filter row: a search box, one or more `<Select size="sm">`,
// and a Clear. All three MUST share `rounded-lg` + `py-2.5` + `text-xs` or the row looks ragged.
//
// This is deliberately NOT `inputCls` / `secondaryBtn`. Those belong to FORMS — `rounded-xl`,
// `text-sm`, and `px-5` on the button — and dropping them into a toolbar leaves the search box and
// the Clear visibly rounder and taller than the Select between them. The pattern was already
// established by hand in CustomersView / UsersView; naming it here stops the next toolbar guessing.
//
// Not for the PILL toolbars (pool chips, the GRN bucket filter): those are `rounded-full px-3
// py-1.5 text-[11px]` and a control from this family next to one of those is just as ragged.

/** Search input for a list toolbar. Pair with `pl-9` when it carries a leading search icon. */
export const toolbarInputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs text-[var(--ink)] outline-none transition-all placeholder:text-[var(--faint)] focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Date input for a list toolbar. Same `rounded-lg` / `py-2.5` / `text-xs` family as the search box and
 * `<Select size="sm">`, so a From/To pair sits level with the controls beside it. Wrap it in a
 * `<label>` carrying the From/To word — a bare date input gives no clue which end of the range it is.
 */
export const toolbarDateCls =
  "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60";

/** Button sized to sit in a list toolbar beside a `<Select size="sm">` — e.g. Clear, Export CSV. */
export const toolbarBtn =
  "flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-60";

/**
 * The toolbar's PRIMARY action — "Submit stock", "Move stock". Accent fill so it reads as the
 * page's main verb, but on `toolbarBtn`'s geometry (`rounded-lg`, `py-2.5`, `text-xs`) rather than
 * `primaryBtn`'s form geometry (`rounded-xl`, `px-5`), which sits visibly taller and rounder than
 * the Select and Clear beside it.
 */
export const toolbarPrimaryBtn =
  "flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60";

/**
 * Wrapper that pushes a toolbar's ACTIONS to the right-hand end of the row, away from the filters.
 *
 * Page actions live here rather than in the top bar via `<PageActions>`. The top bar is right for a
 * TabPills switcher — navigation, which people scan for at the top — but an action that operates on
 * the list is a different thing: on a wide screen the top bar's right edge is most of a screen away
 * from the rows it acts on, and it sits close enough to the browser's own chrome to read as part of
 * it. The toolbar row already exists and its right half is empty, so this costs no vertical space.
 *
 * The `ml-auto` that does the pushing is left to the CALL SITE, and must carry that toolbar's own
 * row breakpoint — `sm:ml-auto` on the portal lists, `lg:ml-auto` on the audit filter bar. Baking
 * one in here would push the group to the right edge while the toolbar was still stacked in a
 * column, leaving the actions marooned opposite the filters on exactly the narrow screens where
 * they should sit directly under them.
 */
export const toolbarActionsCls = "flex flex-wrap items-center gap-2";

/**
 * The CARD a list page's toolbar row sits in — the surface holding search, the filter Selects, the
 * Filters trigger, Export and the page's primary action.
 *
 * Every list page had this string written out by hand, and half of them wrote it WITHOUT
 * `sm:flex-wrap`. That single missing class is not cosmetic: a flex row that cannot wrap and cannot
 * fit pushes its last children straight out of the card. Measured in Chrome against the real
 * compiled CSS, at a 768px viewport (where `sm:flex-row` is live and the sidebar has taken 256px)
 * the row overflowed by 78px on Customers, 199px on Warehouses, 182px on Suppliers, 142px on IRM
 * Items, 92px on Rental Items and 190px on Portal Jobs — carrying "Add customer", "Add warehouse",
 * "Add supplier", Export and the Filters trigger past the card's right edge, where `#app`'s
 * `overflow-hidden` clipped them with no scrollbar and no way to reach them.
 *
 * So the wrap lives HERE, once, rather than being remembered thirteen times. A toolbar that fits
 * still renders as a single row — wrapping costs nothing until it is needed.
 *
 * Two densities, differing only in gap and padding: the standard list page, and the compact one the
 * portal and engineer screens use. Anything else about them must stay the same, which is the other
 * reason to name them.
 */
const listToolbarBase =
  "flex shrink-0 flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xs sm:flex-row sm:flex-wrap sm:items-center";

/** Standard list-page toolbar card. */
export const listToolbarCls = `${listToolbarBase} gap-3 p-4`;

/** Denser variant for the customer portal and engineer screens. */
export const compactListToolbarCls = `${listToolbarBase} gap-2 p-3`;

/**
 * A COUNT PILL — the shape every pending-work number wears, wherever it appears.
 *
 * The height and the minimum width are stated, not inherited from padding, and that is the whole
 * point of the constant. Without them the badge's box was whatever its text happened to measure:
 * "9" came out ~18x18 and read as a circle, "28" came out ~24x18 and read as an oval, so one
 * sidebar column showed two different shapes depending on the number in it. `rounded-full` on a box
 * that is not square gives a stadium, never a circle — the round ones were an accident of padding.
 *
 * `min-w` equal to `h` makes a single digit a TRUE circle and lets 2–3 characters grow into a pill
 * of the same height, which is the convention every dense product uses for unbounded counts. A fixed
 * circle sized for "99+" was the alternative, and it leaves every single-digit badge sitting in an
 * oversized ring.
 *
 * Geometry only. TONE stays with the caller: the sidebar badge is solid and loud, the tab and row
 * counts are tinted and quiet, and that difference is deliberate.
 */
export const countPillCls =
  "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-extrabold leading-none tabular-nums";
