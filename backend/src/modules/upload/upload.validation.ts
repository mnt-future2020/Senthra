import { z } from "zod";

// The browser's half of a direct upload. Everything here is a CLAIM — the size and media type are used
// to fail early and to pick a resource type, and neither is trusted: the signed preset caps the real
// size at Cloudinary and finalize reads the stored file. What the client cannot send at all is the
// folder, the public id or the resource type; those are the server's, and they are signed.

const OBJECT_ID = /^[a-f0-9]{24}$/i;

export const signatureRequestSchema = z.object({
  purpose: z.string().trim().min(1, "Upload type is required."),
  fileName: z.string().trim().min(1, "File name is required.").max(200),
  sizeBytes: z.coerce.number().int().min(1, "Upload a valid file."),
  mediaType: z.string().trim().min(1, "File type is required.").max(120),
  // Present for purposes that attach to an existing record, so the caller's access to it is checked
  // BEFORE a signature is issued rather than after a 10 MB upload.
  targetId: z.string().regex(OBJECT_ID, "Select a valid record.").optional(),
  // Carried here for the same reason as targetId. The PO guard rejects the reserved issued-PO archive
  // label, and the pre-check could not see it — the controller passed `undefined` — so that rejection
  // only ever landed at finalize, i.e. after the whole file had been uploaded. The finalize check
  // remains the authoritative one (the record can change while a file is in flight); this just lets
  // the guard do at signature time what its own doc comment says it does.
  label: z.string().trim().max(80).optional(),
});
export type SignatureRequestInput = z.infer<typeof signatureRequestSchema>;

export const finalizeRequestSchema = z.object({
  purpose: z.string().trim().min(1, "Upload type is required."),
  // The FULL public id Cloudinary returned, folder included. Looked up in the pending ledger — an id
  // this server never issued has no row, and finalize refuses it.
  publicId: z.string().trim().min(1).max(300),
  // Both are needed to check Cloudinary's own response signature, whose payload is exactly
  // `public_id` + `version`.
  version: z.union([z.string().trim().min(1), z.number()]),
  signature: z.string().trim().min(1).max(200),
  fileName: z.string().trim().min(1, "File name is required.").max(200),
  mediaType: z.string().trim().min(1).max(120),
  label: z.string().trim().max(80).optional(),
  targetId: z.string().regex(OBJECT_ID, "Select a valid record.").optional(),
});
export type FinalizeRequestInput = z.infer<typeof finalizeRequestSchema>;
