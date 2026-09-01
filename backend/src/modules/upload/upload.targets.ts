import { badRequest } from "../../utils/http-error.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as prfService from "#modules/purchase-request/purchase-request.service.js";
import * as poService from "#modules/purchase-order/purchase-order.service.js";
import * as grnService from "#modules/goods-in/goods-in.service.js";
import * as hireDeliveryService from "#modules/rental-receipt/rental-receipt.service.js";

import { UPLOAD_PURPOSES, type UploadPurposeKey } from "./upload.catalog.js";
import { commitAttachment, releasePending, stampPendingAsset, type VerifiedAsset } from "./upload.service.js";

/**
 * Where each `attach` purpose sends its verified asset.
 *
 * The upload module knows how to authorise an upload and prove what arrived; it does NOT know what a
 * purchase-request attachment IS. That belongs to the module that already owns the caps, the audit
 * event and the DTO, and this is the two-line bridge to it — deliberately thin, so the upload path
 * cannot become a second implementation of the same business rules.
 */

type PreCheck = (targetId: string, fileSizeBytes: number, label: string | undefined, actor?: AuditActor) => Promise<void>;
/**
 * `documentType` is LAST and optional on purpose: exactly one target has a document group to put it
 * in, and appending it leaves the other three untouched rather than renumbering every call site for
 * a value they have no use for. A target that ignores it is not losing information — it never had a
 * picker to produce one.
 *
 * The pre-check does not take it. The caps it enforces (count, total bytes) are properties of the
 * REQUEST, not of a group within it, and splitting them per group would quietly break the invariant
 * that a PO must be able to absorb a whole PRF's documents — see PRF_ATTACHMENT_MAX_COUNT.
 */
type Attach = (
  targetId: string,
  asset: VerifiedAsset,
  label: string | undefined,
  actor?: AuditActor,
  documentType?: string,
) => Promise<unknown>;

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
    attach: async (id, asset, label, actor, documentType) => {
      await commitAttachment(asset, (tx) =>
        prfService.attachUploadedAsset(id, { ...asset, label, documentType }, actor, tx),
      );
      const dto = await prfService.getPurchaseRequest(id, actor);
      // The group goes to the audit too. THIS is the call that fires on every real upload — the
      // service's own `if (!tx)` branch never runs on this path, because finalize always passes a
      // transaction — so omitting it here left the trail recording an attachment with no group,
      // while removal recorded one. The tests passed because they exercise the tx-less path.
      prfService.recordAttachmentAudit(dto, actor, documentType);
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
  hire_delivery_photo: {
    preCheck: (id, bytes, _label, actor) => hireDeliveryService.assertCanAttach(id, bytes, actor),
    attach: async (id, asset, label, actor) => {
      await commitAttachment(asset, (tx) =>
        hireDeliveryService.attachUploadedAsset(id, { ...asset, label }, actor, tx),
      );
      const dto = await hireDeliveryService.getRentalReceipt(id, actor);
      hireDeliveryService.recordAttachmentAudit(dto, actor);
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
 * `return-url` and `deferred-attach` purposes have no record to attach to yet — a job being created,
 * a van-stock request being composed — so the URL goes back to the form and is written when the user
 * saves. They differ in what happens to the ledger row, and that difference is the whole point:
 * `return-url` releases it (an abandoned form leaks the asset — the remaining, separately-deferred
 * gap), while `deferred-attach` keeps it so the reaper reclaims exactly that case.
 */
export async function attachTo(
  purpose: UploadPurposeKey,
  targetId: string | undefined,
  asset: VerifiedAsset,
  label: string | undefined,
  actor?: AuditActor,
  documentType?: string,
): Promise<{ attachment: unknown } | { url: string }> {
  const mode = UPLOAD_PURPOSES[purpose].mode;
  if (mode === "deferred-attach") {
    // The row is KEPT. Stamping the URL onto it is what lets the save path find this identity again
    // from the only thing the form holds — and leaving the row pending is what lets the reaper
    // reclaim the asset if that save never comes. See FinalizeMode's note on the mode.
    await stampPendingAsset(asset);
    return { url: asset.url };
  }
  if (mode === "return-url") {
    await releasePending(asset.publicId);
    return { url: asset.url };
  }
  const target = TARGETS[purpose];
  if (!target) throw badRequest("That upload type can't be attached.");
  if (!targetId) throw badRequest("Select the record to attach this to.");
  return { attachment: await target.attach(targetId, asset, label, actor, documentType) };
}
