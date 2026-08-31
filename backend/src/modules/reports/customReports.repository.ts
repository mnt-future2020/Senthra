import { prisma } from "../../lib/prisma.js";

// ── Custom Report reads ────────────────────────────────────────────────────────────────────────
//
// Only the two reads no existing module already exposes. Stock Movement needs nothing here — the
// unified movement feed answers it whole — and that is the pattern: a report is a VIEW of an
// authoritative source, so this file stays small on purpose.
//
// Deliberately owned by the reports module rather than added to goods-management or engineer-stock:
// these are reporting projections, not business operations, and the modules that own the write paths
// should not grow read shapes that exist only for a report.

/**
 * Resolve job stock movements to the project their job belongs to.
 *
 * ONE batched read for the whole page — never per row. `Job.projectId` is a REQUIRED relation, so a
 * job always resolves to exactly one project; the live project name wins, with the job's own snapshot
 * as the fallback for a project row since hard-deleted (CustomerProject has no soft delete).
 */
export async function findMovementJobProjects(
  movementIds: string[],
): Promise<Map<string, { jobNumber: string; projectId: string; projectName: string; siteId: string | null; siteName: string | null }>> {
  const map = new Map<string, { jobNumber: string; projectId: string; projectName: string; siteId: string | null; siteName: string | null }>();
  if (movementIds.length === 0) return map;
  for (let i = 0; i < movementIds.length; i += 500) {
    const rows = await prisma.jobStockMovement.findMany({
      where: { id: { in: movementIds.slice(i, i + 500) } },
      select: {
        id: true,
        // `siteId` + the snapshotted `siteName` — the report filters on the id and prints the name,
        // and the snapshot is what keeps a row readable after a site is renamed or removed.
        job: {
          select: {
            jobNumber: true, projectId: true, projectName: true, siteId: true, siteName: true,
            project: { select: { name: true } },
            site: { select: { name: true } },
          },
        },
      },
    });
    for (const r of rows) {
      if (!r.job) continue;
      map.set(r.id, {
        jobNumber: r.job.jobNumber,
        projectId: r.job.projectId,
        projectName: r.job.project?.name ?? r.job.projectName ?? "(deleted project)",
        siteId: r.job.siteId ?? null,
        siteName: r.job.site?.name ?? r.job.siteName ?? null,
      });
    }
  }
  return map;
}

/**
 * Current engineer holdings — a POSITION, not a movement.
 *
 * Quantities only. Engineer-held stock is not valued anywhere in this system, and putting a figure
 * here would be the first place it happened; `IrmItem.standardCostPence` is a catalogue cost, not
 * what was paid, and is nullable besides.
 *
 * Zero balances are excluded: an engineer who returned everything holds nothing, and a page of
 * zeroes is noise.
 *
 * `take` is the REPORT CAP, never a page size, and the caller pages the returned set itself.
 *
 * That is forced by the sort. The display order is engineer name then item name, and both live on
 * RELATIONS (`User.firstName`, `IrmItem.name`) — Prisma on MongoDB cannot order by a relation field,
 * so the ordering has to happen here, in memory, after the read. Taking a page-sized `take` first and
 * sorting it afterwards (which is what this did) returns an ARBITRARY N rows in Mongo's own order and
 * then alphabetises just those, so "the first 100" was not the first 100 of anything, and paging over
 * it would have shown a different arbitrary slice each time with overlaps and gaps.
 *
 * So the whole candidate set is read once, bounded by the cap, and sorted as a unit. The caller
 * slices. Engineer holdings are one row per engineer per item with stock on hand — small, and already
 * the shape every other position read in this codebase uses.
 */
export async function findEngineerHoldings(
  filters: { engineerId?: string; irmItemId?: string },
  take: number,
): Promise<Array<{ engineerName: string; itemName: string; itemCode: string; quantity: number }>> {
  const rows = await prisma.engineerStockBalance.findMany({
    where: {
      quantityOnHand: { gt: 0 },
      ...(filters.engineerId ? { engineerId: filters.engineerId } : {}),
      ...(filters.irmItemId ? { irmItemId: filters.irmItemId } : {}),
    },
    select: {
      quantityOnHand: true,
      engineer: { select: { firstName: true, lastName: true, email: true } },
      irmItem: { select: { name: true, code: true } },
    },
    take,
  });
  return rows
    .map((r) => ({
      // No single `name` column on User — composed the same way every other engineer label is.
      engineerName: `${r.engineer?.firstName ?? ""} ${r.engineer?.lastName ?? ""}`.trim() || (r.engineer?.email ?? "(unknown)"),
      itemName: r.irmItem?.name ?? "(unknown item)",
      itemCode: r.irmItem?.code ?? "",
      quantity: r.quantityOnHand,
    }))
    .sort((a, b) => a.engineerName.localeCompare(b.engineerName) || a.itemName.localeCompare(b.itemName));
}
