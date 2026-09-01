/**
 * The catalogue ids a job's kit lines refer to, split by which catalogue they belong to.
 *
 * A kit line can be sourced from the IRM catalogue, the rental catalogue, customer stock or nothing
 * at all, and each carries its own id field. These feed the batched `?ids=` lookups that let an
 * edit-mode picker show an item sitting outside the page loaded at mount.
 *
 * Split into named helpers rather than left inline because sending the WRONG list is a silent
 * failure: IRM ids handed to the rental endpoint simply resolve to nothing, and the picker goes back
 * to rendering blank on a line that is set — the exact bug this all exists to fix.
 *
 * Blank ids are deliberately kept: `missingIds` drops them, and doing it in two places invites the
 * two to disagree.
 */

interface KitLineRef {
  lineType: string;
  irmItemId: string;
  rentalItemId: string;
}

/** Ids of the lines hired from the RENTAL catalogue. */
export const rentalKitLineIds = (lines: KitLineRef[]): string[] =>
  lines.filter((l) => l.lineType === "rental").map((l) => l.rentalItemId);

/** Ids of the lines taken from the IRM catalogue. */
export const irmKitLineIds = (lines: KitLineRef[]): string[] =>
  lines.filter((l) => l.lineType === "irm").map((l) => l.irmItemId);
