import * as irmTypeService from "./irm-type.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param } from "../../utils/request.js";
import type { CreateIrmTypeInput, UpdateIrmTypeInput } from "./irm-type.validation.js";

// GET /irm-types
export const listIrmTypes = asyncHandler(async (_req, res) => {
  res.json({ irmTypes: await irmTypeService.listIrmTypes() });
});

// GET /irm-types/:id  (id or key)
export const getIrmType = asyncHandler(async (req, res) => {
  const irmType = await irmTypeService.getIrmType(param(req, "id"));
  res.json({ irmType });
});

// POST /irm-types
export const createIrmType = asyncHandler(async (req, res) => {
  const irmType = await irmTypeService.createIrmType(req.body as CreateIrmTypeInput, actorFrom(req));
  res.status(201).json({ irmType });
});

// PUT /irm-types/:id
export const updateIrmType = asyncHandler(async (req, res) => {
  const irmType = await irmTypeService.updateIrmType(
    param(req, "id"),
    req.body as UpdateIrmTypeInput,
    actorFrom(req),
  );
  res.json({ irmType });
});

// DELETE /irm-types/:id — blocked when IRM items still use the type.
export const deleteIrmType = asyncHandler(async (req, res) => {
  await irmTypeService.deleteIrmType(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});
