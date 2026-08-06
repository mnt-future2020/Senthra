/**
 * One-off maintenance: give every IRM item a SKU, and fold existing ones into the canonical shape.
 *
 * The SKU used to be optional. It is now mandatory on create AND update, which means an item that
 * never got one becomes UNEDITABLE the moment that rule ships: open it, change the name, save, and
 * the server refuses over a field the person never touched. Run this BEFORE the new rule reaches
 * production, or immediately after if it already has.
 *
 * Two kinds of repair, both derived from the same helpers the service uses:
 *
 *   MISSING    — no SKU at all. One is generated from the item's name + category, exactly as a new
 *                item would get (categoryPrefix + name slug, suffixed if taken).
 *   MALFORMED  — a SKU that isn't in canonical shape, e.g. 'FBR-SM12- G652D' with a stray inner
 *                space. Normalized in place. Doing it here rather than leaving it to the next edit
 *                matters: the update path treats a normalized re-send as "no change", so an
 *                un-normalized row would silently rename itself the first time anyone saved it,
 *                burning the old SKU forever on an unrelated edit.
 *
 * DRY RUN BY DEFAULT — it only reports what it would change. Pass --apply to write.
 *
 *   npx tsx --conditions=development src/scripts/backfill-irm-sku.ts
 *   npx tsx --conditions=development src/scripts/backfill-irm-sku.ts --apply
 *
 * Safe to re-run: an item already holding a canonical, unique SKU is never touched, so a second
 * pass finds nothing. Soft-deleted items are included on purpose — SKUs are unique FOREVER across
 * every row, so a soft-deleted item without one still has to be allocated a value that no future
 * item can be handed.
 *
 * It also REPORTS (never rewrites) any SKU that collides with an item CODE. That combination makes
 * the goods/van-stock scan ambiguous, but which of the two rows should keep the string is a
 * judgement call, not something a script should guess.
 *
 * This script deliberately talks to Prisma directly rather than through a repository: it is one-off
 * maintenance, not part of the layered request path.
 */

import { prisma } from "../lib/prisma.js";
import { buildSkuCandidate, normalizeSku, withSuffix } from "../modules/irm/sku.js";

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  console.log(APPLY ? "APPLYING IRM SKU backfill.\n" : "DRY RUN — no writes. Re-run with --apply to write.\n");

  const items = await prisma.irmItem.findMany({
    select: {
      id: true,
      code: true,
      name: true,
      sku: true,
      deletedAt: true,
      irmCategory: { select: { name: true } },
    },
    orderBy: { code: "asc" },
  });

  // Every SKU (lowercased) and every code that is already spoken for. Held in memory so candidates
  // allocated earlier in THIS run are also treated as taken — two same-named items in the same
  // category would otherwise both be handed the identical SKU and the second write would fail.
  const takenSkus = new Set(items.map((i) => i.sku?.toLowerCase()).filter((s): s is string => Boolean(s)));
  const codes = new Set(items.map((i) => i.code.toLowerCase()));

  const claim = (candidate: string): string => {
    for (let n = 1; n <= 50; n++) {
      const attempt = withSuffix(candidate, n);
      const key = attempt.toLowerCase();
      if (!takenSkus.has(key) && !codes.has(key)) {
        takenSkus.add(key);
        return attempt;
      }
    }
    throw new Error(`Could not find a free SKU from "${candidate}".`);
  };

  const missing: { id: string; code: string; name: string; to: string; deleted: boolean }[] = [];
  const malformed: { id: string; code: string; name: string; from: string; to: string }[] = [];
  const codeClashes: { code: string; name: string; sku: string }[] = [];

  for (const i of items) {
    if (!i.sku) {
      const to = claim(buildSkuCandidate(i.name, i.irmCategory?.name));
      missing.push({ id: i.id, code: i.code, name: i.name, to, deleted: Boolean(i.deletedAt) });
      continue;
    }

    if (codes.has(i.sku.toLowerCase())) {
      codeClashes.push({ code: i.code, name: i.name, sku: i.sku });
    }

    const canonical = normalizeSku(i.sku);
    // Normalizing can land on a string another item already owns (two rows differing only by the
    // stray characters being removed). claim() walks past it rather than writing a duplicate the
    // unique index would reject.
    if (canonical && canonical !== i.sku) {
      takenSkus.delete(i.sku.toLowerCase());
      malformed.push({ id: i.id, code: i.code, name: i.name, from: i.sku, to: claim(canonical) });
    }
  }

  console.log(
    `IrmItem: ${items.length} rows, ${missing.length} without a SKU, ${malformed.length} malformed, ` +
      `${codeClashes.length} clashing with an item code\n`,
  );

  for (const m of missing) {
    console.log(`  ${m.code}  ${m.name}${m.deleted ? "  [soft-deleted]" : ""}`);
    console.log(`      sku: null → ${m.to}`);
  }
  for (const m of malformed) {
    console.log(`  ${m.code}  ${m.name}`);
    console.log(`      sku: "${m.from}" → ${m.to}`);
  }

  if (codeClashes.length) {
    console.log(`\n  SKUs that are also an item CODE — left untouched, they need a human:`);
    for (const c of codeClashes) console.log(`  ${c.code}  ${c.name}  ← sku "${c.sku}"`);
  }

  if (APPLY) {
    for (const m of [...missing, ...malformed]) {
      await prisma.irmItem.update({
        where: { id: m.id },
        data: { sku: m.to, skuLower: m.to.toLowerCase() },
      });
    }
  }

  console.log(
    `\n${APPLY ? "Backfilled" : "Would backfill"} ${missing.length + malformed.length} item(s). ` +
      `${codeClashes.length} code clash(es) reported and left as-is.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
