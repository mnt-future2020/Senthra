import { badRequest } from "../../utils/http-error.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as prfService from "#modules/purchase-request/purchase-request.service.js";
import * as poService from "#modules/purchase-order/purchase-order.service.js";
import * as grnService from "#modules/goods-in/goods-in.service.js";

import { UPLOAD_PURPOSES, type UploadPurposeKey } from "./upload.catalog.js";
import { commitAttachment, releasePending, type VerifiedAsset } from "./upload.service.js";

/**
 * Where each `attach` purpose sends its verified asset.
 *
 * The upload module knows how to authorise an upload and prove what arrived; it does NOT know what a
 * purchase-request attachment IS. That belongs to the module that already owns the caps, the audit
 * event and the DTO, and this is the two-line bridge to it — deliberately thin, so the upload path
 * cannot become a second implementation of the same business rules.
 */

type PreCheck = (targetId: string, fileSizeBytes: number, label: string | undefined, actor?: AuditActor) => Promise<void>;
type Attach = (targetId: string, asset: VerifiedAsset, label: string | undefined, actor?: AuditActor) => Promise<unknown>;

/**
 * Write inside the transaction, then read the DTO OUTSIDE it.
 *
 * Each module's `attachUploadedAsset` ends by re-reading its own record, and that read runs on the
 * default client — which cannot see a row still uncommitted in `tx`. So the DTO it returns on this
 * path is the record as it was BEFORE the attachment, with the new file missing from the list. The
 * frontend sets its state from that DTO, so a successful upload emptied the list on screen until the
 * page was reloaded. Reading after the commit is what makes the response describe what was written.
 *
 * The non-transactional callers (the older base64 endpoints) pass no `tx` and were never affected.
 *
 * The audit event is fired here for the same reason, one step further on. `audit.record` writes on
 * the default client and is fire-and-forget, so it does not roll back with `tx` — fired inside the
 * transaction, an abort after the attachment write (a Mongo write conflict, a failed pending-row
 * delete) would leave the trail asserting an attachment that does not exist. Each module still owns
 * the event's definition; this only chooses the moment, which is after the commit and after the DTO
 * proves what was written.
 */
const TARGETS: Partial<Record<UploadPurposeKey, { preCheck: PreCheck; attach: Attach }>> = {
  prf_attachment: {
    preCheck: (id, bytes, _label, actor) => prfService.assertCanAttach(id, bytes, actor),
    attach: async (id, asset, label, actor) => {
      await commitAttachment(asset, (tx) => prfService.attachUploadedAsset(id, { ...asset, label }, actor, tx));
      const dto = await prfService.getPurchaseRequest(id, actor);
      prfService.recordAttachmentAudit(dto, actor);
      return dto;
    },
  },
  po_attachment: {
    preCheck: (id, bytes, label, actor) => poService.assertCanAttach(id, bytes, label, actor),
    attach: async (id, asset, label, actor) => {
      await commitAttachment(asset, (tx) => poService.attachUploadedAsset(id, { ...asset, label }, actor, tx));
      const dto = await poService.getPurchaseOrder(id, actor);
      poService.recordAttachmentAudit(dto, actor);
      return dto;
    },
  },
  grn_attachment: {
    preCheck: (id, bytes, _label, actor) => grnService.assertCanAttach(id, bytes, actor),
    attach: async (id, asset, label, actor) => {
      await commitAttachment(asset, (tx) => grnService.attachUploadedAsset(id, { ...asset, label }, actor, tx));
      const dto = await grnService.getGoodsReceipt(id, actor);
      grnService.recordAttachmentAudit(dto, actor);
      return dto;
    },
  },
};

/**
 * The module's own guard, run before a signature is issued.
 *
 * Only a courtesy — it fails the user in a second rather than after a 10 MB upload. The authoritative
 * run is `attachTo`, because the record can change while a file is in flight.
 */
export function preCheckFor(purpose: UploadPurposeKey): ((targetId: string, fileSizeBytes: number, label: string | undefined, actor?: AuditActor) => Promise<void>) | null {
  const t = TARGETS[purpose];
  return t ? t.preCheck : null;
}

/**
 * Hand a verified asset to the module that owns it.
 *
 * `return-url` purposes have no record to attach to yet — a job being created, a van-stock request
 * being composed — so the URL goes back to the form and is written when the user saves, exactly as it
 * is today. The ledger row is released at that point, which means an abandoned FORM still leaks the
 * asset: the existing, separately-deferred gap that needs those `String[]` fields to become rows.
 */
export async function attachTo(
  purpose: UploadPurposeKey,
  targetId: string | undefined,
  asset: VerifiedAsset,
  label: string | undefined,
  actor?: AuditActor,
): Promise<{ attachment: unknown } | { url: string }> {
  if (UPLOAD_PURPOSES[purpose].mode === "return-url") {
    await releasePending(asset.publicId);
    return { url: asset.url };
  }
  const target = TARGETS[purpose];
  if (!target) throw badRequest("That upload type can't be attached.");
  if (!targetId) throw badRequest("Select the record to attach this to.");
  return { attachment: await target.attach(targetId, asset, label, actor) };
}
