import * as irmCategoryService from "./irm-category.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param } from "../../utils/request.js";
import type {
  CreateIrmCategoryInput,
  UpdateIrmCategoryInput,
} from "./irm-category.validation.js";

// GET /irm-categories
export const listIrmCategories = asyncHandler(async (_req, res) => {
  res.json({ irmCategories: await irmCategoryService.listIrmCategories() });
});

// GET /irm-categories/:id  (id or key)
export const getIrmCategory = asyncHandler(async (req, res) => {
  const irmCategory = await irmCategoryService.getIrmCategory(param(req, "id"));
  res.json({ irmCategory });
});

// POST /irm-categories
export const createIrmCategory = asyncHandler(async (req, res) => {
  const irmCategory = await irmCategoryService.createIrmCategory(
    req.body as CreateIrmCategoryInput,
    actorFrom(req),
  );
  res.status(201).json({ irmCategory });
});

// PUT /irm-categories/:id
export const updateIrmCategory = asyncHandler(async (req, res) => {
  const irmCategory = await irmCategoryService.updateIrmCategory(
    param(req, "id"),
    req.body as UpdateIrmCategoryInput,
    actorFrom(req),
  );
  res.json({ irmCategory });
});

// DELETE /irm-categories/:id — blocked when IRM items still use the category.
export const deleteIrmCategory = asyncHandler(async (req, res) => {
  await irmCategoryService.deleteIrmCategory(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});
