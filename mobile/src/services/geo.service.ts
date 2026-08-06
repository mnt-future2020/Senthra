import { api } from "../lib/api";

// Address fields resolved from a UK postcode (postcodes.io, via the backend).
// Street-level (address line 1) is NOT available — only city / county / country.
export interface PostcodeAddress {
  city: string | null;
  county: string | null;
  country: string;
}

// Resolve a UK postcode to address fields for form autofill. Returns null when the
// postcode can't be resolved (unknown postcode, or the lookup service is down).
export function lookupPostcode(postcode: string): Promise<PostcodeAddress | null> {
  return api<{ result: PostcodeAddress | null }>(
    `/geo/postcode/${encodeURIComponent(postcode.trim())}`,
  ).then((r) => r.result);
}
