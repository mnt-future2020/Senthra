/**
 * IRM SKU shape + suggestion. Pure string work — no DB, no I/O — so every rule here is directly
 * testable, and the item form can mirror the same suggestion to show the user what they will get
 * while the server stays the only thing that decides what is actually stored.
 *
 * The canonical shape is uppercase alphanumerics joined by single dashes (CAB-CAT6-305M). It is the
 * shape every SKU already in the data follows, and it keeps a SKU safe to print on a label, put in
 * a URL, and compare case-insensitively against the `skuLower` mirror column.
 */

// Matches the `sku` column's validation ceiling.
export const SKU_MAX = 80;
// The name-derived portion. Long enough to stay recognisable, short enough that the whole SKU still
// fits a table cell: 3 (category code) + 1 + 24 caps a generated SKU at 28 characters, against the
// 9-14 the hand-written ones in the data actually run to.
const SLUG_MAX = 24;
// Backstop only — a generated candidate can't exceed 28, so this never binds today. It exists so
// raising SLUG_MAX can't quietly eat the room a "-99" uniqueness suffix needs inside SKU_MAX.
const CANDIDATE_MAX = SKU_MAX - 3;

/** The canonical shape. A normalized SKU always satisfies this (or is empty). */
export const SKU_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

/**
 * Fold whatever a human typed into the canonical shape: "cat6 u/utp 305m" → "CAT6-U-UTP-305M".
 * Returns "" when nothing usable survives (e.g. "###"), which callers treat as "not supplied".
 */
export function normalizeSku(raw: string | null | undefined): string {
  const collapsed = (raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Truncating can leave a dash exposed at the end, so strip again after the slice.
  return collapsed.slice(0, SKU_MAX).replace(/-+$/, "");
}

/**
 * Three-character category code — the warehouse convention the existing hand-written SKUs already
 * follow (Cable → CAB, Fibre → FIB, Connectors → CON). Two categories can share a code; the
 * name-derived part and the uniqueness suffix keep the full SKU distinct.
 */
export function categoryPrefix(categoryName: string | null | undefined): string {
  const letters = (categoryName ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return letters.slice(0, 3) || "IRM";
}

/**
 * The suggested SKU for an item: category code + a slug of the name. Whole words only, so a name is
 * never cut mid-word — "24-Port Fibre Patch Panel — 1U Rack Mount" in Fibre becomes
 * FIB-24-PORT-FIBRE-PATCH-PANEL rather than FIB-24-PORT-FIBRE-PATCH-PANEL-1U-RA.
 *
 * This is a CANDIDATE, not a decision: it carries no uniqueness guarantee. The service resolves
 * collisions (see uniqueSku in irm.service.ts).
 */
export function buildSkuCandidate(name: string, categoryName?: string | null): string {
  const prefix = categoryPrefix(categoryName);
  const normalized = normalizeSku(name);

  let slug = "";
  for (const word of normalized.split("-").filter(Boolean)) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > SLUG_MAX) break;
    slug = next;
  }
  // A single word longer than SLUG_MAX leaves the loop with nothing. Hard-truncate rather than
  // return a bare category code, which would collide with every other item in that category.
  if (!slug) slug = normalized.slice(0, SLUG_MAX).replace(/-+$/, "");

  const candidate = slug ? `${prefix}-${slug}` : prefix;
  return candidate.slice(0, CANDIDATE_MAX).replace(/-+$/, "");
}

/** nth attempt at a free SKU: the candidate itself, then -2, -3, … */
export function withSuffix(candidate: string, n: number): string {
  return n <= 1 ? candidate : `${candidate}-${n}`;
}
