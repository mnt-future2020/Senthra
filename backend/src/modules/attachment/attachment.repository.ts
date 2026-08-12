import { prisma } from "../../lib/prisma.js";

/**
 * How many committed rows still reference one Cloudinary asset.
 *
 * This is the ONLY question the deletion path asks, and it is asked across EVERY attachment table
 * rather than only the ones that can currently share an asset. Today that sharing happens in one
 * place — PRF → PO conversion copies an attachment's identity instead of re-uploading the file, so
 * two rows name one asset — and it would be cheaper to count just those two tables. Counting all
 * three is the point: the alternative is a rule that each future attachment consumer has to
 * remember to register, which is the same "the sweep has to know every caller" failure that made a
 * Cloudinary-wide orphan scan the wrong design.
 *
 * A cross-table read, so it has no owning model and lives in a module of its own. That is NOT the
 * central Attachment/Asset model this codebase may eventually want: there is no table here, no
 * writes, and no polymorphic parent — the three domain tables stay exactly as they are.
 *
 * Identity is the PAIR. Matching `publicId` alone would treat an `image` and a `raw` asset that
 * happen to share an id as the same file, which is the one way this function could report a
 * reference that does not exist and let a live asset be destroyed.
 */
export async function countRefs(resourceType: string, publicId: string): Promise<number> {
  const where = { resourceType, publicId };
  const [prf, po, grn] = await Promise.all([
    prisma.purchaseRequestAttachment.count({ where }),
    prisma.purchaseOrderAttachment.count({ where }),
    prisma.goodsReceiptAttachment.count({ where }),
  ]);
  return prf + po + grn;
}
