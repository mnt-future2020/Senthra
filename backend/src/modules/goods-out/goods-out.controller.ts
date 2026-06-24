import * as goodsOutService from "./goods-out.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt } from "../../utils/request.js";
import type { CreateGoodsOutInput, GoodsOutCancelInput, UpdateGoodsOutInput } from "./goods-out.validation.js";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// GET /goods-out?search=&status=&warehouse=&engineer=&sort=&page=&pageSize=
export const listGoodsOut = asyncHandler(async (req, res) => {
  const { search, status, warehouse, engineer, sort, page, pageSize } = req.query;
  res.json(
    await goodsOutService.listGoodsOut(
      {
        search: str(search),
        status: str(status),
        warehouse: str(warehouse),
        engineer: str(engineer),
        sort: str(sort),
        page: queryInt(page),
        pageSize: queryInt(pageSize),
      },
      actorFrom(req),
    ),
  );
});

// GET /goods-out/:id  (id or code)
export const getGoodsOut = asyncHandler(async (req, res) => {
  res.json({ goodsOut: await goodsOutService.getGoodsOut(param(req, "id"), actorFrom(req)) });
});

// POST /goods-out
export const createGoodsOut = asyncHandler(async (req, res) => {
  const goodsOut = await goodsOutService.createGoodsOut(req.body as CreateGoodsOutInput, actorFrom(req));
  res.status(201).json({ goodsOut });
});

// PATCH /goods-out/:id  (draft only)
export const updateGoodsOut = asyncHandler(async (req, res) => {
  res.json({ goodsOut: await goodsOutService.updateGoodsOut(param(req, "id"), req.body as UpdateGoodsOutInput, actorFrom(req)) });
});

// DELETE /goods-out/:id  (draft only)
export const deleteGoodsOut = asyncHandler(async (req, res) => {
  await goodsOutService.deleteGoodsOut(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});

// --- workflow transitions (state machine enforced in the service) -----------
export const dispatchGoodsOut = asyncHandler(async (req, res) => {
  res.json({ goodsOut: await goodsOutService.dispatchGoodsOut(param(req, "id"), actorFrom(req)) });
});
export const cancelGoodsOut = asyncHandler(async (req, res) => {
  const { reason } = req.body as GoodsOutCancelInput;
  res.json({ goodsOut: await goodsOutService.cancelGoodsOut(param(req, "id"), reason, actorFrom(req)) });
});
