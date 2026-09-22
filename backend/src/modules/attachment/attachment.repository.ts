import { prisma } from "../../lib/prisma.js";

/**
 * How many committed rows still reference one Cloudinary asset.
 *
 * This is the ONLY question the deletion path asks, and it is asked across EVERY attachment table
 * rather than only the ones that can currently share an asset. Today that sharing happens in one
 * place — PRF → PO conversion copies an attachment's identity instead of re-uploading the file, so
 * two rows name one asset — and it would be cheaper to count just those two tables. Counting all
 * of them is the point: the alternative is a rule that each future attachment consumer has to
 * remember to register, which is the same "the sweep has to know every caller" failure that made a
 * Cloudinary-wide orphan scan the wrong design. JobAttachment joined the list the moment it
 * existed, for exactly that reason — a table missing from this count is a table whose rows do not
 * protect their asset, and the failure is silent: the file simply disappears from a live record.
 *
 * A cross-table read, so it has no owning model and lives in a module of its own. That is NOT the
 * central Attachment/Asset model this codebase may eventually want: there is no table here, no
 * writes, and no polymorphic parent — the domain tables stay exactly as they are.
 *
 * Identity is the PAIR. Matching `publicId` alone would treat an `image` and a `raw` asset that
 * happen to share an id as the same file, which is the one way this function could report a
 * reference that does not exist and let a live asset be destroyed.
 *
 * Identity is now a TRIPLE, not a pair: the same (publicId, resourceType) can exist on two
 * providers at once, and a row on one must not protect an asset on the other. The provider is the
 * coordinate that tells them apart.
 *
 * `null` MEANS CLOUDINARY, and matching it needs BOTH `null` and `isSet: false` — a row written
 * before the column existed has the field ABSENT, not null, and in this Prisma+MongoDB setup a bare
 * `{ field: null }` filter does not match an absent field. Getting that wrong here is the worst
 * shape of bug available: legacy rows would count as zero references and their live files would be
 * destroyed. See lib/__tests__/null-vs-absent.test.ts, which fails on an unpaired occurrence.
 */
export async function countRefs(
  provider: string | null,
  resourceType: string,
  publicId: string,
): Promise<number> {
  const where = {
    resourceType,
    publicId,
    // Cloudinary is the legacy value, so it has to match rows that say so explicitly AND rows that
    // never said anything. Any other provider was written by code that always sets the column.
    ...(provider === null || provider === "cloudinary"
      ? { OR: [{ storageProvider: null }, { storageProvider: { isSet: false } }, { storageProvider: "cloudinary" }] }
      : { storageProvider: provider }),
  };
  const [prf, po, grn, job, hire] = await Promise.all([
    prisma.purchaseRequestAttachment.count({ where }),
    prisma.purchaseOrderAttachment.count({ where }),
    prisma.goodsReceiptAttachment.count({ where }),
    prisma.jobAttachment.count({ where }),
    // Condition photographs on a hire delivery. Joined the list the moment the table existed, for the
    // reason stated above — a table missing from this count is a table whose rows do not protect their
    // asset, and the file simply disappears from a live record.
    prisma.rentalReceiptAttachment.count({ where }),
  ]);
  return prf + po + grn + job + hire;
}
