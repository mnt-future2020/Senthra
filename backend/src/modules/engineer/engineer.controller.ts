import type { Request } from "express";

import * as engineerService from "./engineer.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { forbidden } from "../../utils/http-error.js";

// The engineer always reads THEIR OWN data — the scoping id is the authenticated principal's id,
// never a route param (mirrors the customer portal's `customerId(req)` safety, keyed on User.id).
function ownId(req: Request): string {
  const id = actorFrom(req).id;
  if (!id) throw forbidden("Engineer access required.");
  return id;
}

// GET /engineer/overview — dashboard: My Stock summary + My Dispatches count + Recent Activity.
export const getOwnOverview = asyncHandler(async (req, res) => {
  res.json({ overview: await engineerService.getOwnOverview(ownId(req)) });
});

// GET /engineer/stock — the engineer's own held IRM stock.
export const getOwnStock = asyncHandler(async (req, res) => {
  res.json({ stock: await engineerService.getOwnStock(ownId(req)) });
});
