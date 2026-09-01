import * as transferService from "./engineer-transfer.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import type { CreateTransferInput, DeclineInput, AcknowledgeInput, UploadAttachmentInput } from "./engineer-transfer.validation.js";

// Collapse a possibly-array query value (e.g. `?search=a&search=b`) to its first string, matching the
// `param()` convention — otherwise a duplicated param silently coerces to undefined → empty results.

// POST /engineer-transfers
export const createTransfer = asyncHandler(async (req, res) => {
  const transfer = await transferService.createTransfer(req.body as CreateTransferInput, actorFrom(req));
  res.status(201).json({ transfer });
});

// GET /engineer-transfers  (admin oversight — all transfers)
export const listAll = asyncHandler(async (req, res) => {
  const { status, engineerId, ownership, sort, search, raisedFrom, raisedTo, page, pageSize } = req.query;
  const result = await transferService.listAll(
    {
      status: queryStr(status),
      engineerId: queryStr(engineerId),
      ownership: queryStr(ownership),
      sort: queryStr(sort),
      search: queryStr(search),
      raisedFrom: queryStr(raisedFrom),
      raisedTo: queryStr(raisedTo),
      page: queryInt(page),
      pageSize: queryInt(pageSize),
    },
    actorFrom(req),
  );
  res.json(result);
});

// GET /engineer-transfers/mine  (engineer self-service — own transfers)
export const listMine = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  const engineerId = actor.id ?? "";
  if (!engineerId) {
    res.status(400).json({ error: "Could not determine engineer identity." });
    return;
  }
  const { role, status, sort, search, raisedFrom, raisedTo, page, pageSize } = req.query;
  const roleVal = queryStr(role) as "incoming" | "outgoing" | "all" | undefined;
  const result = await transferService.listMine(engineerId, {
    role: roleVal,
    status: queryStr(status),
    sort: queryStr(sort),
    search: queryStr(search),
    raisedFrom: queryStr(raisedFrom),
    raisedTo: queryStr(raisedTo),
    page: queryInt(page),
    pageSize: queryInt(pageSize),
  });
  res.json(result);
});

// GET /engineer-transfers/holders
export const getHolders = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  const requesterId = actor.id ?? "";
  const { ownership, irmItemId, customerStockEntryId } = req.query;
  const holders = await transferService.getHolders(
    {
      ownership: queryStr(ownership) ?? "",
      irmItemId: queryStr(irmItemId),
      customerStockEntryId: queryStr(customerStockEntryId),
    },
    requesterId,
  );
  res.json({ holders });
});

// GET /engineer-transfers/holdings/:engineerId  (a source engineer's transferable holdings)
export const getEngineerHoldings = asyncHandler(async (req, res) => {
  res.json({ holdings: await transferService.getEngineerHoldings(param(req, "engineerId")) });
});

// GET /engineer-transfers/company-search?search=  (engineer company/IRM discovery)
export const companyCandidates = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  const candidates = await transferService.getCompanyCandidates(queryStr(req.query.search) ?? "", actor.id ?? "");
  res.json({ candidates });
});

// GET /engineer-transfers/customer-search?search=  (engineer customer-consignment discovery)
export const customerCandidates = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  const candidates = await transferService.getCustomerCandidates(queryStr(req.query.search) ?? "", actor.id ?? "");
  res.json({ candidates });
});

// GET /engineer-transfers/:id
export const getOne = asyncHandler(async (req, res) => {
  res.json({ transfer: await transferService.getOne(param(req, "id"), actorFrom(req)) });
});

// POST /engineer-transfers/:id/approve
export const approve = asyncHandler(async (req, res) => {
  res.json({ transfer: await transferService.approve(param(req, "id"), actorFrom(req)) });
});

// POST /engineer-transfers/:id/decline
export const decline = asyncHandler(async (req, res) => {
  const { reason } = (req.body as DeclineInput) ?? {};
  res.json({ transfer: await transferService.decline(param(req, "id"), reason, actorFrom(req)) });
});

// POST /engineer-transfers/:id/cancel
export const cancel = asyncHandler(async (req, res) => {
  res.json({ transfer: await transferService.cancel(param(req, "id"), actorFrom(req)) });
});

// POST /engineer-transfers/:id/override
export const override = asyncHandler(async (req, res) => {
  res.json({ transfer: await transferService.override(param(req, "id"), actorFrom(req)) });
});

// POST /engineer-transfers/:id/acknowledge
export const acknowledge = asyncHandler(async (req, res) => {
  const { signature } = req.body as AcknowledgeInput;
  res.json({ transfer: await transferService.acknowledge(param(req, "id"), signature, actorFrom(req)) });
});

// POST /engineer-transfers/attachments
export const uploadAttachment = asyncHandler(async (req, res) => {
  const { image } = req.body as UploadAttachmentInput;
  res.json(await transferService.uploadAttachment(image));
});
