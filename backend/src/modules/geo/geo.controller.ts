import * as geoService from "./geo.service.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param } from "../../utils/request.js";

// GET /geo/postcode/:postcode — resolve a UK postcode to address fields for form
// autofill. Always 200; `result` is null when the postcode can't be resolved.
export const lookupPostcode = asyncHandler(async (req, res) => {
  const result = await geoService.lookupPostcodeAddress(param(req, "postcode"));
  res.json({ result });
});
