import * as categoryService from "./category.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param } from "../../utils/request.js";
import type { CreateCategoryInput, UpdateCategoryInput } from "./category.validation.js";

// GET /categories
export const listCategories = asyncHandler(async (_req, res) => {
  res.json({ categories: await categoryService.listCategories() });
});

// GET /categories/:id  (id or key)
export const getCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.getCategory(param(req, "id"));
  res.json({ category });
});

// POST /categories
export const createCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.createCategory(req.body as CreateCategoryInput, actorFrom(req));
  res.status(201).json({ category });
});

// PUT /categories/:id
export const updateCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.updateCategory(
    param(req, "id"),
    req.body as UpdateCategoryInput,
    actorFrom(req),
  );
  res.json({ category });
});

// DELETE /categories/:id — blocked when the category is in use.
export const deleteCategory = asyncHandler(async (req, res) => {
  await categoryService.deleteCategory(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});
