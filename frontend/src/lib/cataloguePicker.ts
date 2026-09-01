/**
 * The search behaviour every catalogue picker shares, with no opinion about WHICH catalogue.
 *
 * There are two of these now (IRM items, rental items) and the rules that matter are identical:
 * a bounded first page, server-side search for everything past it, and — above all — the decision
 * about when it is SAFE to offer "create a new one", which is the whole reason these pickers exist.
 * That rule is subtle enough that a second copy of it would drift and quietly start inviting
 * duplicate catalogue entries, so it lives here once and is tested once.
 *
 * Only the MARKUP differs per catalogue (what a row shows, what "create" opens); the state machine
 * does not.
 */

/**
 * Below this, a query is not worth searching on and certainly not worth offering to create from:
 * one or two characters match half the catalogue, so "no results" would mean nothing.
 */
export const CATALOGUE_MIN_QUERY = 2;

/**
 * How many ids one lookup may carry.
 *
 * Mirrors the server's own bound (`MAX_IRM_IDS` / `MAX_RENTAL_IDS`), which is also the page cap an
 * id lookup is allowed — ask for more in one request and the extras come back missing, with a
 * perfectly ordinary-looking short page and nothing to say the answer is partial. Keep the three in
 * step: lowering the server bound without lowering this reintroduces exactly that silent truncation.
 */
export const MAX_IDS_PER_LOOKUP = 200;

/**
 * Split an id list into requests the server will answer in FULL.
 *
 * Order is preserved and every id appears exactly once, so the caller can fire the batches
 * independently and merge each answer as it lands.
 */
export function chunkIds(ids: string[], size: number = MAX_IDS_PER_LOOKUP): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
  return batches;
}

/**
 * Fold newly-seen rows into the list a form holds.
 *
 * Returns the ORIGINAL array when nothing changed — pickers merge on every search response, and a
 * fresh array each time would re-render every line of the surrounding form for rows it already had.
 */
export function mergeById<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((i) => [i.id, i]));
  let changed = false;
  for (const item of incoming) {
    if (byId.get(item.id) === item) continue;
    byId.set(item.id, item); // a known id keeps its position; a new one lands at the end
    changed = true;
  }
  return changed ? [...byId.values()] : existing;
}

/**
 * Which of the ids a form NEEDS are not in the list it currently holds — the input to a batch
 * lookup. Blank ids are dropped (an empty line has no item yet) and the result is de-duplicated.
 */
export function missingIds(needed: (string | null | undefined)[], have: { id: string }[]): string[] {
  const known = new Set(have.map((i) => i.id));
  const out: string[] = [];
  for (const id of needed) {
    if (!id || known.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

export interface CreateOffer {
  canCreate: boolean;
  query: string;
  searching: boolean;
  searchFailed: boolean;
  resultCount: number;
}

/**
 * May the picker offer "add this as a new one"?
 *
 * Only once a search has SETTLED and genuinely returned nothing. The two guards that look
 * redundant are the ones that matter:
 *
 *  • `searching` — mid-flight the count is still 0, so without this the create button flashes up
 *    under the user's fingers a moment before the existing row arrives. That is exactly how a
 *    catalogue grows a second copy of something it already had.
 *  • `searchFailed` — a failed lookup does not mean "no such item", it means we do not know. On a
 *    network blip the honest answer is to say so, not to invite a duplicate.
 */
export function shouldOfferCreate({ canCreate, query, searching, searchFailed, resultCount }: CreateOffer): boolean {
  if (!canCreate || searching || searchFailed) return false;
  if (query.trim().length < CATALOGUE_MIN_QUERY) return false;
  return resultCount === 0;
}

/** A search that has come back, tagged with the query it answers. */
export interface SettledSearch<T> {
  query: string;
  items: T[];
  failed: boolean;
}

export interface CatalogueView<T> {
  options: T[];
  searching: boolean;
  searchFailed: boolean;
  /**
   * Matches the server returned that the CALLER's own rule excluded. Reported separately because
   * "no such item" and "that item exists but you can't use it here" are different answers, and
   * collapsing them into one empty state is how someone creates a duplicate of it.
   */
  excludedCount: number;
  /**
   * How many rows MATCHED, before the caller's rule was applied — i.e. `options` plus
   * `excludedCount`.
   *
   * This, never `options.length`, is what the create-offer must be given. A picker with a
   * `filterItem` rule can show an empty list while the catalogue plainly holds the match: it was
   * excluded, not absent. Offering "add this as a new item" there invites a duplicate of a row that
   * already exists — the exact failure `shouldOfferCreate` exists to prevent.
   */
  matchCount: number;
}

/**
 * What the open menu should show, given what has been typed and the last answer that came back.
 *
 * The whole correctness of a picker sits in one comparison: an answer counts only if it answers the
 * query ON SCREEN. That single rule covers three situations that otherwise need separate flags —
 * the debounce window, a request still in flight, and a slow response for a query two words ago —
 * and in all three the honest state is "still searching", which is what keeps the create option
 * hidden until the catalogue has genuinely been checked.
 *
 * Below the search threshold the caller's own loaded page is filtered locally, so a single letter
 * still narrows the menu without a round trip.
 */
export function catalogueSearchView<T>(
  query: string,
  settled: SettledSearch<T> | null,
  seed: T[],
  /** Local matcher for the seed — should match the SAME fields the server searches. */
  matches: (item: T, query: string) => boolean,
  /** The caller's own domain rule for what may be picked here. Applied to seed AND results alike. */
  filterItem?: (item: T) => boolean,
): CatalogueView<T> {
  const q = query.trim();
  const allow = (rows: T[]) => (filterItem ? rows.filter(filterItem) : rows);

  if (q.length < CATALOGUE_MIN_QUERY) {
    const matched = seed.filter((i) => matches(i, q));
    const options = allow(matched);
    return {
      options,
      searching: false,
      searchFailed: false,
      excludedCount: matched.length - options.length,
      matchCount: matched.length,
    };
  }
  const answered = settled !== null && settled.query === q;
  if (!answered) return { options: [], searching: true, searchFailed: false, excludedCount: 0, matchCount: 0 };
  const options = allow(settled.items);
  return {
    options,
    searching: false,
    searchFailed: settled.failed,
    excludedCount: settled.items.length - options.length,
    matchCount: settled.items.length,
  };
}

/** Case-insensitive "does any of these fields contain the query" — the usual local matcher. */
export function matchesAnyField(fields: (string | null | undefined)[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(q));
}
