import * as rentalItemService from "./rental-item.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendCsv } from "../../utils/csv-response.js";
import { param } from "../../utils/request.js";
import type { CreateRentalItemInput, UpdateRentalItemInput } from "./rental-item.validation.js";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// GET /rental-items
export const listRentalItems = asyncHandler(async (req, res) => {
  const q = req.query;
  res.json(
    await rentalItemService.listRentalItems({
      status: str(q.status),
      categoryId: str(q.categoryId),
      search: str(q.search),
      page: num(q.page),
      pageSize: num(q.pageSize),
    }),
  );
});

// GET /rental-items/:id  (id or code)
export const getRentalItem = asyncHandler(async (req, res) => {
  res.json({ rentalItem: await rentalItemService.getRentalItem(param(req, "id")) });
});

// GET /rental-items/:id/barcode  (id or code)
//
// The label, rendered on demand — see the service. A GET because nothing is created: the same code
// returns the same image every time, which is exactly why it is not stored.
export const getRentalItemBarcode = asyncHandler(async (req, res) => {
  res.json(await rentalItemService.renderBarcode(param(req, "id")));
});

// POST /rental-items
export const createRentalItem = asyncHandler(async (req, res) => {
  const rentalItem = await rentalItemService.createRentalItem(
    req.body as CreateRentalItemInput,
    actorFrom(req),
  );
  res.status(201).json({ rentalItem });
});

// PATCH /rental-items/:id
export const updateRentalItem = asyncHandler(async (req, res) => {
  const rentalItem = await rentalItemService.updateRentalItem(
    param(req, "id"),
    req.body as UpdateRentalItemInput,
    actorFrom(req),
  );
  res.json({ rentalItem });
});

// DELETE /rental-items/:id — soft delete, blocked while any PRF or PO line references it.
export const deleteRentalItem = asyncHandler(async (req, res) => {
  await rentalItemService.deleteRentalItem(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});

// GET /rental-items/export — the catalogue as CSV.
export const exportRentalItemsCsv = asyncHandler(async (req, res) => {
  const q = req.query;
  sendCsv(
    res,
    "rental-items",
    await rentalItemService.exportRentalItemsCsv(
      { status: str(q.status), categoryId: str(q.categoryId), search: str(q.search) },
      actorFrom(req),
    ),
  );
});
