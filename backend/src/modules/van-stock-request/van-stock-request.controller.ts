import * as vsrService from "./van-stock-request.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { forbidden } from "../../utils/http-error.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import type {
  ApproveVanStockRequestInput,
  CloseShortInput,
  CreateVanStockRequestInput,
  DeclineVanStockRequestInput,
  FulfilVanStockRequestInput,
  ScanLookupInput,
  UploadImageInput,
  WalkInInput,
} from "./van-stock-request.validation.js";

// POST /van-stock-requests  (engineer raises a restock or return)
export const create = asyncHandler(async (req, res) => {
  res.status(201).json({ request: await vsrService.create(req.body as CreateVanStockRequestInput, actorFrom(req)) });
});

// GET /van-stock-requests/mine  (the signed-in engineer's own requests)
export const listMine = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  if (!actor.id) throw forbidden("Could not determine engineer identity.");
  const { status, type, createdVia, search, sort, page, pageSize } = req.query;
  res.json(await vsrService.listMine(actor.id, { status: queryStr(status), type: queryStr(type), createdVia: queryStr(createdVia), search: queryStr(search), sort: queryStr(sort), page: queryInt(page), pageSize: queryInt(pageSize) }));
});

// GET /van-stock-requests/mine/open-lines?type=  (duplicate-warning source for the composer)
export const openLines = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  if (!actor.id) throw forbidden("Could not determine engineer identity.");
  res.json({ items: await vsrService.openLineItems(actor.id, queryStr(req.query.type) ?? "restock") });
});

// GET /van-stock-requests/my-holdings  (return composer source — own on-hand)
export const myHoldings = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  if (!actor.id) throw forbidden("Could not determine engineer identity.");
  res.json({ holdings: await vsrService.myHoldings(actor.id) });
});

// GET /van-stock-requests/item-search?q=  (IRM catalogue search for the restock composer)
export const itemSearch = asyncHandler(async (req, res) => {
  res.json({ items: await vsrService.searchItems(queryStr(req.query.q) ?? "") });
});

// GET /van-stock-requests/warehouse-item-search?warehouseId=&q=  (walk-in composer — on-hand annotated)
export const warehouseItemSearch = asyncHandler(async (req, res) => {
  res.json({ items: await vsrService.searchWarehouseItems(actorFrom(req), queryStr(req.query.warehouseId) ?? "", queryStr(req.query.q) ?? "") });
});

// GET /van-stock-requests/requestable-item-search?q=  (engineer composer — only items in stock somewhere)
export const requestableItemSearch = asyncHandler(async (req, res) => {
  res.json({ items: await vsrService.searchRequestableItems(queryStr(req.query.q) ?? "") });
});

// GET /van-stock-requests/warehouses-lite  (active warehouses for the composer pickers)
export const warehousesLite = asyncHandler(async (_req, res) => {
  res.json({ warehouses: await vsrService.listWarehousesLite() });
});

// GET /van-stock-requests/availability?irmItemIds=a,b,c&rentalItemIds=d,e
// Per-warehouse availability for the cart — advisory. The two id lists stay SEPARATE because they
// address different catalogues; one merged list keyed on a bare id could not tell a tester from a
// cable. `rentalItemIds` is optional, so a client that predates it (and the mobile app until its own
// pass) keeps working unchanged.
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const idList = (raw: string | undefined): string[] =>
  (raw ?? "").split(",").map((s) => s.trim()).filter((s) => OBJECT_ID_RE.test(s));
export const availability = asyncHandler(async (req, res) => {
  const ids = idList(queryStr(req.query.irmItemIds));
  const rentalIds = idList(queryStr(req.query.rentalItemIds));
  res.json({ warehouses: await vsrService.availability(ids, rentalIds) });
});

// GET /van-stock-requests  (reviewer queue; ?warehouseId= narrows to one warehouse's queue)
export const listAll = asyncHandler(async (req, res) => {
  const { status, type, priority, createdVia, search, sort, warehouseId, page, pageSize } = req.query;
  res.json(await vsrService.listAll(actorFrom(req), { status: queryStr(status), type: queryStr(type), priority: queryStr(priority), createdVia: queryStr(createdVia), search: queryStr(search), sort: queryStr(sort), warehouseId: queryStr(warehouseId), page: queryInt(page), pageSize: queryInt(pageSize) }));
});

// GET /van-stock-requests/pending-count  (reviewer badge — scoped to the actor's warehouses)
export const pendingCount = asyncHandler(async (req, res) => {
  res.json({ count: await vsrService.countPending(actorFrom(req)) });
});

// GET /van-stock-requests/:id
export const getOne = asyncHandler(async (req, res) => {
  res.json({ request: await vsrService.getOne(param(req, "id"), actorFrom(req)) });
});

// POST /van-stock-requests/:id/approve  (reviewer — restock only)
export const approve = asyncHandler(async (req, res) => {
  res.json({ request: await vsrService.approve(param(req, "id"), req.body as ApproveVanStockRequestInput, actorFrom(req)) });
});

// POST /van-stock-requests/:id/decline  (reviewer)
export const decline = asyncHandler(async (req, res) => {
  res.json({ request: await vsrService.decline(param(req, "id"), req.body as DeclineVanStockRequestInput, actorFrom(req)) });
});

// POST /van-stock-requests/:id/cancel  (requester, while pending)
export const cancel = asyncHandler(async (req, res) => {
  res.json({ request: await vsrService.cancel(param(req, "id"), actorFrom(req)) });
});

// POST /van-stock-requests/:id/cancel-remaining  (requester, while partially fulfilled)
export const cancelRemaining = asyncHandler(async (req, res) => {
  res.json({ request: await vsrService.cancelRemaining(param(req, "id"), actorFrom(req)) });
});

// POST /van-stock-requests/:id/close-short  (reviewer, while partially fulfilled)
export const closeShort = asyncHandler(async (req, res) => {
  res.json({ request: await vsrService.closeShort(param(req, "id"), req.body as CloseShortInput, actorFrom(req)) });
});

// POST /van-stock-requests/:id/fulfil  (reviewer — one atomic posting)
export const fulfil = asyncHandler(async (req, res) => {
  res.json({ request: await vsrService.fulfil(param(req, "id"), req.body as FulfilVanStockRequestInput, actorFrom(req)) });
});

// POST /van-stock-requests/scan-lookup  (reviewer — request-scoped barcode lookup)
export const scanLookup = asyncHandler(async (req, res) => {
  res.json({ result: await vsrService.scanLookup(req.body as ScanLookupInput, actorFrom(req)) });
});

// POST /van-stock-requests/walk-in  (reviewer creates pre-approved for a counter walk-in)
export const walkIn = asyncHandler(async (req, res) => {
  res.status(201).json({ request: await vsrService.walkIn(req.body as WalkInInput, actorFrom(req)) });
});

// POST /van-stock-requests/attachments  (returns a URL; does NOT create a request)
export const uploadAttachment = asyncHandler(async (req, res) => {
  res.json(await vsrService.uploadImage((req.body as UploadImageInput).image, "attachment"));
});

