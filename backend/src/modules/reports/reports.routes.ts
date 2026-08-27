import { Router } from "express";

import * as reportsController from "./reports.controller.js";
import { requireAnyPermission, requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { exportLimiter, writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { scheduleEnabledSchema, scheduleWriteSchema } from "./reports.validation.js";

const router = Router();
router.use(requireAuth);

// EVERY finance route is gated on `reports.finance.view`, not on `reports.view`.
//
// The split is the point: plenty of people need a stock or movement report and should never see what
// anything cost. Authorization is enforced HERE, server-side — the response for an unauthorised actor
// is a 403, not a payload with the money fields blanked, so no financial figure is ever serialised
// for someone who may not see it.
router.get("/finance/summary", requirePermission("reports.finance.view"), reportsController.financeSummary);

// Export additionally needs `reports.export`: viewing a figure on screen and walking out with the
// whole spend file are different acts, which is the same split the other 12 *.export rights make.
router.get(
  "/finance/summary/export.csv",
  requirePermission("reports.finance.view"),
  requirePermission("reports.export"),
  exportLimiter,
  reportsController.financeSummaryExport,
);
router.get(
  "/finance/lines/export.csv",
  requirePermission("reports.finance.view"),
  requirePermission("reports.export"),
  exportLimiter,
  reportsController.financeLinesExport,
);

// XLSX reuses the EXACT same authorization as the CSV exports — finance.view to see the figures at
// all, plus export to take the file away. A new permission would have been a second answer to a
// question already answered, and a weaker one: whoever may download the CSV may download the
// workbook, because they are the same data.
router.get(
  "/finance/export.xlsx",
  requirePermission("reports.finance.view"),
  requirePermission("reports.export"),
  exportLimiter,
  reportsController.financeWorkbookExport,
);

// ── Custom Reports (FLOW 10B) — general/operational reporting, NOT finance ─────────────────────
//
// Gated on `reports.view`, not `reports.finance.view`: these are stock, project and engineer reports
// and carry no money. A report that ever does carry money declares `financial: true` in the registry
// and the SERVICE additionally requires the finance right — so the gate cannot be forgotten at the
// route when such a report is added.
router.get("/custom/types", requirePermission("reports.view"), reportsController.customReportTypes);
router.get("/custom", requirePermission("reports.view"), reportsController.runCustomReport);
router.get(
  "/custom/export.csv",
  requirePermission("reports.view"),
  requirePermission("reports.export"),
  exportLimiter,
  reportsController.exportCustomReportCsv,
);
router.get(
  "/custom/export.xlsx",
  requirePermission("reports.view"),
  requirePermission("reports.export"),
  exportLimiter,
  reportsController.exportCustomReportXlsx,
);

// ── Scheduled reports ──────────────────────────────────────────────────────────────────────────
//
// Gated on EITHER reporting right at the route, with the REAL gate inside the service: every read and
// write resolves the schedule's report key against what this actor may run, so a finance schedule
// needs `reports.finance.view` and a stock one needs `reports.view`.
//
// Either-or, because the two rights are independent by design and both lead here. `reports.view`
// alone would lock the Finance report — the one the client cares most about — away from a
// finance-only role, whose own service rule says they may schedule it; `reports.finance.view` alone
// would do the mirror image to stock reports. The route only answers "may this person reach the
// scheduling surface at all"; which reports appear on it is not a question a route can answer.
//
// No separate `reports.schedule` permission: the catalogue already answers this. Scheduling is
// running a report (its view right) PLUS taking the file away (`reports.export`) — the exact pair the
// download routes above ask for. A fourth right would be a second, weaker answer to a question that
// already has one, and would let a role hold `reports.schedule` without `reports.export` — i.e. get
// the spend workbook emailed to it every month while being denied the download button.
//
// WRITING a schedule therefore additionally requires `reports.export`, which — unlike the view
// rights — is flat, report-agnostic and so CAN be enforced at the route. The service asks for it
// again (it is the layer that outlives this request), plus on resume, where the route cannot see
// that `enabled: true` is what makes it an extraction.
//
// READING stays on the either-or gate alone: listing schedules, opening one and reading its run
// history disclose configuration and delivery state, never a report figure and never a file.
const GATE = requireAnyPermission("reports.view", "reports.finance.view");
const EXPORT = requirePermission("reports.export");

router.get("/schedules/types", GATE, reportsController.schedulableReportTypes);
// Who may be sent a report. Same gate as the rest, plus EXPORT — this picker only fills in a form an
// actor without it cannot save. The service additionally re-checks that this actor may schedule the
// report NAMED in the query before it discloses anybody.
router.get("/schedules/recipients", GATE, EXPORT, reportsController.scheduleRecipientOptions);
router.get("/schedules", GATE, reportsController.listSchedules);
router.get("/schedules/:id", GATE, reportsController.getSchedule);
router.get("/schedules/:id/runs", GATE, reportsController.listScheduleRuns);
//
// `validateBody` is the SHAPE gate and runs before the controller, the same order every other write
// route in this codebase uses. It checks types and ranges only — which reports this actor may
// schedule and which recipients are eligible need the database and stay in the service, which
// re-checks the semantics regardless of how the request arrived.
router.post("/schedules", GATE, EXPORT, writeLimiter, validateBody(scheduleWriteSchema), reportsController.createSchedule);
router.put("/schedules/:id", GATE, EXPORT, writeLimiter, validateBody(scheduleWriteSchema), reportsController.updateSchedule);
// Pause stays reachable without `reports.export`; the service gates RESUME. See setEnabled().
router.patch(
  "/schedules/:id/enabled",
  GATE,
  writeLimiter,
  validateBody(scheduleEnabledSchema),
  reportsController.setScheduleEnabled,
);
// Delete carries EXPORT like create and edit do. Pause is the deliberate exception (see above) — it
// stops files leaving; deleting destroys a schedule and its run history, which is not an off switch.
router.delete("/schedules/:id", GATE, EXPORT, writeLimiter, reportsController.deleteSchedule);

export default router;
