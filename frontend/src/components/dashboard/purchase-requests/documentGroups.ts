import type { PrfDocumentType } from "@/types/purchase-request";

/**
 * The two document groups a purchase request keeps its files in — named ONCE, for every screen that
 * shows them.
 *
 * A purchase request carries two kinds of paperwork with different jobs. The QUOTE documents are the
 * supplier's offer: what is being charged, and on what terms. The OTHER documents are the case for
 * the request: the spec, the comparison, the approval. A reviewer deciding whether to approve is
 * doing two different readings, and a single merged list makes telling them apart a matter of
 * recognising filenames.
 *
 * This table lives apart from any one component because the create form, the detail overview and the
 * Attachments tab all render the same two groups, and copies of the wording in three files is how
 * one screen ends up calling them something the other two don't. `type` matches PRF_DOCUMENT_TYPES
 * on the server, which is the value actually persisted on the attachment row — the labels below are
 * presentation, and nothing infers a group from them.
 */
export interface PrfDocumentGroup {
  type: PrfDocumentType;
  /** On the create form, where the control sits under the quotation fields. */
  formLabel: string;
  /** On the detail/review screens, where it heads a section rather than labelling one input. */
  detailLabel: string;
  /**
   * What belongs in this group, in the words a buyer would use.
   *
   * Names the FILES ONLY — never the group. Every screen renders this directly under the group's
   * own label, so a lead-in like "The supplier's quotation files for this request —" said nothing
   * the reader had not just read, and cost a whole extra line in a column only ~330px wide.
   */
  help: string;
  /** Shown when the group is empty — says which group is empty, not just "nothing here". */
  emptyText: string;
  /**
   * The same group as a TAG on a single file, which is how the purchase order shows it — singular,
   * because it labels one document rather than heading a list of them.
   *
   * An order cannot use sections the way a request does: a PO's own uploads carry no group, and a
   * section per group would leave them with nowhere to go. Keeping this beside the headings is what
   * stops the two screens naming the same stored value differently.
   */
  chipLabel: string;
}

export const DOCUMENT_GROUPS: readonly PrfDocumentGroup[] = [
  {
    type: "quote",
    formLabel: "Quote document(s)",
    detailLabel: "Quotation",
    help: "The quote itself, a revision, or the email it arrived in.",
    emptyText: "No quote documents yet",
    chipLabel: "Quotation",
  },
  {
    type: "other",
    formLabel: "Other documents",
    detailLabel: "Other documents",
    help: "A specification, comparison sheet or approval document.",
    emptyText: "No other documents yet",
    chipLabel: "Supporting document",
  },
];

/** The subset of a document list that belongs to one group, in the order it was added. */
export function filesInGroup<T extends { documentType: PrfDocumentType }>(
  files: readonly T[],
  type: PrfDocumentType,
): T[] {
  return files.filter((f) => f.documentType === type);
}

/**
 * Drop ONE picked document from the create form's list.
 *
 * By key, never by an index into a rendered group — and that is the whole reason this is a named
 * function rather than an inline filter. The form renders two lists out of one array, so an index
 * means something different in each of them: "remove the first quote file" reaching a list built
 * from the other group is a bug that looks like working code, and it removes the wrong person's
 * document silently. A key is unambiguous in both, which is what makes removing from one group
 * provably leave the other untouched.
 */
export function removeDocument<T extends { _key: string }>(files: readonly T[], key: string): T[] {
  return files.filter((f) => f._key !== key);
}

/**
 * How one file's group reads as a tag, or `null` for a file that has no group.
 *
 * Takes the RAW stored value rather than a resolved `PrfDocumentType`, because the caller is the
 * purchase ORDER, where the column is genuinely nullable and null is MEANINGFUL: a request's absent
 * group means `quote` (see `normalisePrfDocumentType` — every such row came out of a field labelled
 * "Quote document(s)"), but an order's means uncategorised, because an order's own uploads never had
 * a group picker. Normalising here would carry a legacy request's quote onto the order wearing no
 * label while the request itself files it under Quotation, so the same file would answer the same
 * question differently on the two screens.
 */
export function documentChipLabel(value: string | null | undefined): string | null {
  return DOCUMENT_GROUPS.find((g) => g.type === value)?.chipLabel ?? null;
}
