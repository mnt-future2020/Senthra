// Postcode → coordinates via postcodes.io — free, keyless, UK-only, which matches
// the app's UK-postcode validation. Used to derive a site's lat/long on the server
// from the postcode the admin enters (coordinates are never hand-typed).
//
// Best-effort by design: any failure (unknown postcode, network error, timeout)
// resolves to `null` so a site save is NEVER blocked by geocoding. Coordinates are
// an enhancement (a future map pin), not a required field.

const POSTCODES_IO = "https://api.postcodes.io/postcodes";
const TIMEOUT_MS = 4000;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

// Administrative detail + centroid for a UK postcode, from postcodes.io. NOTE: this
// free API returns the area only — there is NO street-level address (house number /
// street), so City/County can be prefilled but Address line 1 stays manual.
export interface PostcodeDetails {
  city: string | null; // admin_district — the town/city (local authority)
  county: string | null; // admin_county — often null for metropolitan areas
  latitude: number | null;
  longitude: number | null;
}

// Look up a UK postcode. Returns null when empty, unknown, or the service is
// unreachable (best-effort — never throws). Shared by the coordinate-only caller
// (geocodePostcode) and the address-autofill endpoint.
export async function lookupPostcode(
  postcode: string | null | undefined,
): Promise<PostcodeDetails | null> {
  const trimmed = postcode?.trim();
  if (!trimmed) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${POSTCODES_IO}/${encodeURIComponent(trimmed)}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null; // 404 (unknown postcode) and friends → no result
    const body = (await res.json()) as {
      result?: {
        latitude?: number | null;
        longitude?: number | null;
        admin_district?: string | null;
        admin_county?: string | null;
      };
    };
    const r = body.result;
    if (!r) return null;
    return {
      city: r.admin_district?.trim() || null,
      county: r.admin_county?.trim() || null,
      latitude: typeof r.latitude === "number" ? r.latitude : null,
      longitude: typeof r.longitude === "number" ? r.longitude : null,
    };
  } catch {
    return null; // network error / timeout / abort — best-effort, never throws
  } finally {
    clearTimeout(timer);
  }
}

// Look up a UK postcode's centroid. Returns null when the postcode is empty,
// unknown, or the service is unreachable.
export async function geocodePostcode(
  postcode: string | null | undefined,
): Promise<Coordinates | null> {
  const d = await lookupPostcode(postcode);
  if (!d || typeof d.latitude !== "number" || typeof d.longitude !== "number") return null;
  return { latitude: d.latitude, longitude: d.longitude };
}
