import * as rentalCategoryService from "./rental-category.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param } from "../../utils/request.js";
import type {
  CreateRentalCategoryInput,
  UpdateRentalCategoryInput,
} from "./rental-category.validation.js";

// GET /rental-categories
export const listRentalCategories = asyncHandler(async (_req, res) => {
  res.json({ rentalCategories: await rentalCategoryService.listRentalCategories() });
});

// GET /rental-categories/:id  (id or key)
export const getRentalCategory = asyncHandler(async (req, res) => {
  const rentalCategory = await rentalCategoryService.getRentalCategory(param(req, "id"));
  res.json({ rentalCategory });
});

// POST /rental-categories
export const createRentalCategory = asyncHandler(async (req, res) => {
  const rentalCategory = await rentalCategoryService.createRentalCategory(
    req.body as CreateRentalCategoryInput,
    actorFrom(req),
  );
  res.status(201).json({ rentalCategory });
});

// PUT /rental-categories/:id
export const updateRentalCategory = asyncHandler(async (req, res) => {
  const rentalCategory = await rentalCategoryService.updateRentalCategory(
    param(req, "id"),
    req.body as UpdateRentalCategoryInput,
    actorFrom(req),
  );
  res.json({ rentalCategory });
});

// DELETE /rental-categories/:id — blocked when rental items still use the category.
export const deleteRentalCategory = asyncHandler(async (req, res) => {
  await rentalCategoryService.deleteRentalCategory(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});
