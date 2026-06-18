import { lookupPostcode } from "../../lib/geocode.js";

export interface PostcodeAddress {
  city: string | null;
  county: string | null;
  country: string;
}

// Resolve a UK postcode to the address fields the master-data forms can prefill.
// The app is UK-only, so country is always "United Kingdom". Returns null when the
// postcode can't be resolved — the form then just leaves the fields for manual entry.
export async function lookupPostcodeAddress(postcode: string): Promise<PostcodeAddress | null> {
  const details = await lookupPostcode(postcode);
  if (!details) return null;
  return { city: details.city, county: details.county, country: "United Kingdom" };
}
