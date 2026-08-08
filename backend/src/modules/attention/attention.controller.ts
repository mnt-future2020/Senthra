import * as attentionService from "./attention.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { notFound } from "../../utils/http-error.js";

// GET /attention?fresh=1 — the whole product's pending-work counts for THIS actor.
// `fresh=1` is what a socket-driven refetch sends: it skips the short burst cache so a live update is
// never delayed. A plain page load takes the cached value.
// Named envelope (`{ attention }`), matching /dashboard/summary's `{ summary }` — the service returns
// the bare summary so other server-side callers can embed it without unwrapping.
export const getAttention = asyncHandler(async (req, res) => {
  const fresh = req.query.fresh === "1" || req.query.fresh === "true";
  res.json({ attention: await attentionService.getAttention(req.principal!, { fresh }) });
});

// GET /attention/entities/:dimension — the same work split per warehouse / per customer, for the list
// screens that show a count on each row.
//
// A SEPARATE endpoint, not another field on the payload above: /attention is fetched by the shell on
// every page load for every user, while these counts are wanted by two list screens. Folding them in
// would make every navigation in the product pay for queries almost none of them use.
//
// An unknown dimension is a 404, not an empty object — a typo'd surface must fail loudly rather than
// render a list with every count silently missing.
const DIMENSIONS = ["warehouse", "customer"] as const;

export const getEntityAttention = asyncHandler(async (req, res) => {
  const dimension = DIMENSIONS.find((d) => d === req.params.dimension);
  if (!dimension) throw notFound("Unknown attention dimension.");
  const fresh = req.query.fresh === "1" || req.query.fresh === "true";
  res.json({ entities: await attentionService.getEntityAttention(req.principal!, dimension, { fresh }) });
});
