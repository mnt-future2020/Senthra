import * as jobTitleService from "./jobTitle.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param } from "../../utils/request.js";
import type {
  CreateJobTitleInput,
  UpdateJobTitleInput,
} from "./jobTitle.validation.js";

// GET /job-titles  (protected) — the full list for the picker + manage screen.
export const listJobTitles = asyncHandler(async (_req, res) => {
  res.json({ jobTitles: await jobTitleService.listJobTitles() });
});

// POST /job-titles  (protected)
export const createJobTitle = asyncHandler(async (req, res) => {
  const jobTitle = await jobTitleService.createJobTitle(
    req.body as CreateJobTitleInput,
    actorFrom(req),
  );
  res.status(201).json({ jobTitle });
});

// PUT /job-titles/:id  (protected) — rename.
export const updateJobTitle = asyncHandler(async (req, res) => {
  const jobTitle = await jobTitleService.updateJobTitle(
    param(req, "id"),
    req.body as UpdateJobTitleInput,
    actorFrom(req),
  );
  res.json({ jobTitle });
});

// DELETE /job-titles/:id  (protected) — removes it from the list (users keep their
// stored title name).
export const deleteJobTitle = asyncHandler(async (req, res) => {
  await jobTitleService.deleteJobTitle(param(req, "id"), actorFrom(req));
  res.json({ ok: true });
});
