// Document Platform — signer resolution. Turns a document's issuer (e.g. a PO's `sentBy` email)
// into a printable signature block: the person's name/title + their signature image (fetched to a
// Buffer). Optional everywhere — returns null when there's no signer or no signature on file, and
// even keeps the name when the image can't be fetched, so generation NEVER fails on the signature.

import { getSignatureForEmail } from "#modules/user/user.service.js";
import { fetchImageBuffer, pdfSafeImageUrl } from "./document.utils.js";
import type { DocumentSignatureBlock } from "./document.types.js";

export async function resolveSignatureBlock(
  signerEmail: string | null | undefined,
): Promise<DocumentSignatureBlock | null> {
  const sig = await getSignatureForEmail(signerEmail);
  if (!sig) return null;
  const image = await fetchImageBuffer(pdfSafeImageUrl(sig.url));
  return { signerName: sig.signerName, jobTitle: sig.jobTitle, image, mimeType: sig.mimeType };
}
