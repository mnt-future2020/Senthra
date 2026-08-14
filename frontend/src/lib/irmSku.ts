/**
 * IRM SKU shape + suggestion — a mirror of `backend/src/modules/irm/sku.ts`.
 *
 * Duplicating it is deliberate and safe here in a way a duplicated VALIDATION rule would not be:
 * the server re-derives and re-checks everything on save, and its answer is what comes back in the
 * response. If this copy ever drifts, the user sees a slightly different suggestion in the box —
 * they never end up with a SKU the server wouldn't have accepted. The uniqueness suffix (-2, -3)
 * is deliberately NOT mirrored: only the server can know what is taken.
 */

export const SKU_MAX = 80;
const SLUG_MAX = 24;
const CANDIDATE_MAX = SKU_MAX - 3;

/** Fold typed input into the canonical shape: "cat6 u/utp 305m" → "CAT6-U-UTP-305M". */
export function normalizeSku(raw: string | null | undefined): string {
  const collapsed = (raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return collapsed.slice(0, SKU_MAX).replace(/-+$/, "");
}

/** Three-character category code — Cable → CAB, Fibre → FIB. */
export function categoryPrefix(categoryName: string | null | undefined): string {
  const letters = (categoryName ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return letters.slice(0, 3) || "IRM";
}

/** The suggested SKU: category code + a whole-word slug of the item name. */
export function buildSkuCandidate(name: string, categoryName?: string | null): string {
  const prefix = categoryPrefix(categoryName);
  const normalized = normalizeSku(name);

  let slug = "";
  for (const word of normalized.split("-").filter(Boolean)) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > SLUG_MAX) break;
    slug = next;
  }
  if (!slug) slug = normalized.slice(0, SLUG_MAX).replace(/-+$/, "");

  const candidate = slug ? `${prefix}-${slug}` : prefix;
  return candidate.slice(0, CANDIDATE_MAX).replace(/-+$/, "");
}

/**
 * Does this SKU lead with a DIFFERENT category's code? Used on the edit form to point out an item
 * whose SKU was set under one category and has since been re-classified.
 *
 * Deliberately narrow: it only reports when the leading segment is another category's three-letter
 * code. A hand-written SKU (CAT6-305-BOX, LC-UPC-SM) leads with something no category claims, so it
 * is left alone rather than nagged about. Returns null when there is nothing worth saying.
 */
export function findSkuPrefixMismatch(
  sku: string,
  currentCategoryName: string | null | undefined,
  categories: readonly { id: string; name: string }[],
  currentCategoryId: string | null | undefined,
): { head: string; owner: string } | null {
  const head = normalizeSku(sku).split("-")[0] ?? "";
  if (!head || head === categoryPrefix(currentCategoryName)) return null;
  const owner = categories.find((c) => c.id !== currentCategoryId && categoryPrefix(c.name) === head);
  return owner ? { head, owner: owner.name } : null;
}
