import { asyncHandler } from "../../utils/async-handler.js";
import { HttpError } from "../../utils/http-error.js";
import { buildDashboardSummary, isSpendPeriod } from "./dashboard.service.js";

// GET /dashboard/summary?spendPeriod=12m|90d|30d (protected: requireAuth; per-section gating
// inside the service). spendPeriod only reshapes the spend-trend series; it defaults to 12m.
export const getSummary = asyncHandler(async (req, res) => {
  const raw = req.query.spendPeriod;
  if (raw !== undefined && !isSpendPeriod(raw)) {
    throw new HttpError(400, "spendPeriod must be one of 12m, 90d, 30d.");
  }
  res.json(await buildDashboardSummary(req.principal!, { spendPeriod: raw }));
});
