import { Router } from "express";

import * as jobController from "./job.controller.js";
import { requireAnyPermission, requireAuth, requireCustomer, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { assignJobSchema, cancelJobSchema, createJobSchema, updateJobSchema, uploadAttachmentSchema } from "./job.validation.js";

const router = Router();

router.use(requireAuth);

router.get("/", requirePermission("jobs.view"), jobController.listJobs);
router.get("/:idOrCode", requirePermission("jobs.view"), jobController.getJob);

router.post("/", requirePermission("jobs.create"), writeLimiter, validateBody(createJobSchema), jobController.createJob);
// create OR edit: the upload button renders in BOTH modes of JobForm, so gating this on jobs.create
// alone 403s an edit-only role the moment they attach a file to an existing job. Same rule as the
// PRF/PO attachment endpoints, which sit behind their module's `edit`.
router.post("/attachment", requireAnyPermission("jobs.create", "jobs.edit"), writeLimiter, validateBody(uploadAttachmentSchema), jobController.uploadAttachment);
router.patch("/:id", requirePermission("jobs.edit"), writeLimiter, validateBody(updateJobSchema), jobController.updateJob);
router.delete("/:id", requirePermission("jobs.delete"), writeLimiter, jobController.deleteJob);

// --- workflow transitions (state machine enforced in the service) -----------
router.post("/:id/assign", requirePermission("jobs.assign"), writeLimiter, validateBody(assignJobSchema), jobController.assignJob);
router.post("/:id/cancel", requirePermission("jobs.cancel"), writeLimiter, validateBody(cancelJobSchema), jobController.cancelJob);

// ----------------------------------------------------------------------------
// Customer-facing portal surface — mounted at /customer/jobs by the route aggregator, alongside the
// customer module's own portal router. Read-only, and scoped to the signed-in customer's company.
//
// A SEPARATE router rather than an entry on the one above: every route above is gated by a
// `jobs.*` staff permission, which a customer principal does not and must not hold. Keeping the two
// apart means the portal route can never inherit a staff gate, and no staff route can ever be
// reached by adding requireCustomer in the wrong place.
// ----------------------------------------------------------------------------
const portalRouter = Router();
portalRouter.use(requireAuth, requireCustomer);

portalRouter.get("/", jobController.getOwnJobs);
portalRouter.get("/:id", jobController.getOwnJob);

export { portalRouter };
export default router;
