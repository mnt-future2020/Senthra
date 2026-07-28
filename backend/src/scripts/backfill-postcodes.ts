/**
 * One-off maintenance: normalise postcodes already stored in the database.
 *
 * Every write path now canonicalises the postcode (utils/postcode.ts, wired into each module's
 * zod schema), but rows saved BEFORE that kept whatever was typed — "ls14dy", "LS14DY",
 * "ls1 4dy". That mixed spacing is why postcode search misses rows: the query matches
 * case-insensitively but NOT space-insensitively. This rewrites the existing rows to the same
 * canonical form the schemas now produce.
 *
 * DRY RUN BY DEFAULT — it only reports what it would change. Pass --apply to write.
 *
 *   npx tsx --conditions=development src/scripts/backfill-postcodes.ts
 *   npx tsx --conditions=development src/scripts/backfill-postcodes.ts --apply
 *
 * Safe to re-run: already-canonical rows are skipped. Rows whose postcode isn't a recognisable
 * UK postcode are reported as "unrecognised" and left completely untouched — they need a human,
 * not a rewrite.
 *
 * This script deliberately talks to Prisma directly rather than through a repository: it is
 * cross-model maintenance, not part of the layered request path.
 */

import { prisma } from "../lib/prisma.js";
import { UK_POSTCODE_RE, formatUkPostcode } from "../utils/postcode.js";

const APPLY = process.argv.includes("--apply");

interface Row {
  id: string;
  postcode: string | null;
}

// Each model that stores a postcode. `label` is what the report prints; `load`/`save` keep the
// Prisma delegate types intact (a generic delegate lookup would erase them).
const TARGETS: { label: string; load: () => Promise<Row[]>; save: (id: string, postcode: string) => Promise<unknown> }[] = [
  {
    label: "Warehouse",
    load: () => prisma.warehouse.findMany({ select: { id: true, postcode: true } }),
    save: (id, postcode) => prisma.warehouse.update({ where: { id }, data: { postcode } }),
  },
  {
    label: "Supplier",
    load: () => prisma.supplier.findMany({ select: { id: true, postcode: true } }),
    save: (id, postcode) => prisma.supplier.update({ where: { id }, data: { postcode } }),
  },
  {
    label: "User",
    load: () => prisma.user.findMany({ select: { id: true, postcode: true } }),
    save: (id, postcode) => prisma.user.update({ where: { id }, data: { postcode } }),
  },
  {
    label: "Customer",
    load: () => prisma.customer.findMany({ select: { id: true, postcode: true } }),
    save: (id, postcode) => prisma.customer.update({ where: { id }, data: { postcode } }),
  },
  {
    label: "CustomerSite",
    load: () => prisma.customerSite.findMany({ select: { id: true, postcode: true } }),
    save: (id, postcode) => prisma.customerSite.update({ where: { id }, data: { postcode } }),
  },
  {
    label: "Job",
    load: () => prisma.job.findMany({ select: { id: true, postcode: true } }),
    save: (id, postcode) => prisma.job.update({ where: { id }, data: { postcode } }),
  },
  {
    label: "Settings.companyPostcode",
    load: async () =>
      (await prisma.settings.findMany({ select: { id: true, companyPostcode: true } })).map((s) => ({
        id: s.id,
        postcode: s.companyPostcode,
      })),
    save: (id, companyPostcode) => prisma.settings.update({ where: { id }, data: { companyPostcode } }),
  },
];

async function main(): Promise<void> {
  console.log(APPLY ? "APPLYING postcode normalisation.\n" : "DRY RUN — no writes. Re-run with --apply to write.\n");

  let totalChanged = 0;
  let totalUnrecognised = 0;

  for (const target of TARGETS) {
    const rows = await target.load();
    const changes: { id: string; from: string; to: string }[] = [];
    const unrecognised: { id: string; value: string }[] = [];

    for (const row of rows) {
      const current = row.postcode;
      if (!current || !current.trim()) continue;
      // Leave anything that isn't a real UK postcode alone — rewriting free text would destroy
      // information, and these rows want a human to look at them.
      if (!UK_POSTCODE_RE.test(current.trim())) {
        unrecognised.push({ id: row.id, value: current });
        continue;
      }
      const canonical = formatUkPostcode(current);
      if (canonical !== current) changes.push({ id: row.id, from: current, to: canonical });
    }

    console.log(`${target.label}: ${rows.length} rows, ${changes.length} to normalise, ${unrecognised.length} unrecognised`);
    for (const c of changes) console.log(`  ${c.id}  "${c.from}" → "${c.to}"`);
    for (const u of unrecognised) console.log(`  ${u.id}  "${u.value}"  ← NOT a UK postcode, left as-is`);

    if (APPLY) {
      for (const c of changes) await target.save(c.id, c.to);
    }

    totalChanged += changes.length;
    totalUnrecognised += unrecognised.length;
  }

  console.log(
    `\n${APPLY ? "Normalised" : "Would normalise"} ${totalChanged} row(s). ` +
      `${totalUnrecognised} row(s) hold a value that isn't a UK postcode and were left untouched.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
