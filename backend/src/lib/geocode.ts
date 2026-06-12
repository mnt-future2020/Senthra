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

// Look up a UK postcode's centroid. Returns null when the postcode is empty,
// unknown, or the service is unreachable.
export async function geocodePostcode(
  postcode: string | null | undefined,
): Promise<Coordinates | null> {
  const trimmed = postcode?.trim();
  if (!trimmed) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${POSTCODES_IO}/${encodeURIComponent(trimmed)}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null; // 404 (unknown postcode) and friends → no coordinates
    const body = (await res.json()) as {
      result?: { latitude?: number | null; longitude?: number | null };
    };
    const { latitude, longitude } = body.result ?? {};
    if (typeof latitude !== "number" || typeof longitude !== "number") return null;
    return { latitude, longitude };
  } catch {
    return null; // network error / timeout / abort — best-effort, never throws
  } finally {
    clearTimeout(timer);
  }
}
