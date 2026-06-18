import { Router } from "express";

import * as geoController from "./geo.controller.js";
import { requireAuth } from "../../middleware/auth.middleware.js";

const router = Router();

router.use(requireAuth);

// Postcode → address lookup (postcodes.io) for the warehouse / supplier / customer-site
// forms. Read-only and returns only public postcode data, so any authenticated user
// may call it — no per-resource permission needed.
router.get("/postcode/:postcode", geoController.lookupPostcode);

export default router;
