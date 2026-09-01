import {
  CATALOGUE_MIN_QUERY,
  catalogueSearchView,
  matchesAnyField,
  mergeById,
  missingIds,
  shouldOfferCreate,
  type CatalogueView,
  type CreateOffer,
  type SettledSearch as GenericSettledSearch,
} from "@/lib/cataloguePicker";
import type { IrmItem } from "@/types/irm";

/**
 * The IRM-specific half of the item picker: which fields a row matches on, and how it reads.
 *
 * Everything else — the search state machine, and above all the rule for when it is SAFE to offer
 * "create a new item" — lives in `lib/cataloguePicker`, shared with the rental picker. That rule is
 * subtle enough that a second copy would drift and start quietly inviting duplicate catalogue
 * entries, so these are deliberately thin bindings over one implementation.
 *
 * Creating the item itself is not modelled here either: that is `IrmItemForm`, the same form the
 * catalogue page renders, so there is no second set of field or validation rules to duplicate.
 */

export const QUICK_CREATE_MIN_QUERY = CATALOGUE_MIN_QUERY;

/** How an item reads in a picker row — the name plus the code people quote to each other. */
export const irmItemLabel = (item: Pick<IrmItem, "name" | "code">): string => `${item.name} (${item.code})`;

/**
 * Local filter over the already-loaded page, matching THE SAME five fields the server searches
 * (`buildWhere` in irm.repository.ts). Matching fewer here would hide a row for the moment between
 * the keystroke and the server's answer, then pop it back — worse than not filtering at all.
 */
export function matchesIrmQuery(item: Pick<IrmItem, "name" | "code" | "sku" | "brand" | "mpn">, query: string): boolean {
  return matchesAnyField([item.name, item.code, item.sku, item.brand, item.mpn], query);
}

/**
 * Fold search results (and newly created items) into the list the FORM holds — it looks items up by
 * id for the price/VAT prefill, the pack-size hint and the supplier's own item code.
 *
 * `barcodeDataUri` is carried over from the row being replaced when the incoming copy has none, and
 * that exception is load-bearing rather than tidy. The LIST endpoint omits the rendered image to
 * stay light, so every merged row arrives without one; the inventory forms fetch it for the SELECTED
 * item alone and patch it in. A plain replace therefore wiped it on the next merge — a picker search
 * that matched the selected item, or the by-ids resolve landing after it — and because those forms
 * remember which ids they have already fetched, nothing ever asked for it again. The print-label
 * control simply vanished from a form that had been showing one.
 *
 * Only ever fills a GAP: an incoming image always wins, so regenerating a barcode still takes.
 */
export const mergeIrmItems = (existing: IrmItem[], incoming: IrmItem[]): IrmItem[] => {
  const byId = new Map(existing.map((i) => [i.id, i]));
  return mergeById(
    existing,
    incoming.map((item) => {
      const held = byId.get(item.id)?.barcodeDataUri;
      return held && !item.barcodeDataUri ? { ...item, barcodeDataUri: held } : item;
    }),
  );
};

/** Which of the ids a form needs are not loaded yet. The input to `useIrmItemsByIds`. */
export const missingIrmIds = (needed: (string | null | undefined)[], have: { id: string }[]): string[] =>
  missingIds(needed, have);

export type QuickCreateOffer = CreateOffer;

/** May the picker offer "add this as a new item"? See `shouldOfferCreate` for why each guard exists. */
export const shouldOfferQuickCreate = (offer: QuickCreateOffer): boolean => shouldOfferCreate(offer);

export type SettledSearch = GenericSettledSearch<IrmItem>;
export type SearchView = CatalogueView<IrmItem>;

/** What the open menu shows. `filterItem` is the caller's own rule — see AdjustStockForm. */
export function searchView(
  query: string,
  settled: SettledSearch | null,
  seed: IrmItem[],
  filterItem?: (item: IrmItem) => boolean,
): SearchView {
  return catalogueSearchView(query, settled, seed, matchesIrmQuery, filterItem);
}
