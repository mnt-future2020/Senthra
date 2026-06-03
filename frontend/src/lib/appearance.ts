// Appearance preference (theme / accent / density / corner radius), persisted in
// a cookie so the server can read it and render the correct look on first paint
// (no theme flash), and the client can keep it in sync.

export const APPEARANCE_COOKIE = "senthra_appearance";
// 1 year — it's a long-lived display preference.
export const APPEARANCE_MAX_AGE = 60 * 60 * 24 * 365;

export type Appearance = {
  theme: "light" | "dark";
  accent: string;
  density: "compact" | "regular";
  radius: number;
};

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "light",
  accent: "#7b6ef0",
  density: "regular",
  radius: 18,
};

// Parse + validate a raw cookie value, filling defaults for anything missing or
// invalid (never trust the cookie contents).
export function parseAppearance(raw: string | undefined | null): Appearance {
  if (!raw) return DEFAULT_APPEARANCE;
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as Partial<Appearance>;
    return {
      theme: v.theme === "dark" ? "dark" : "light",
      accent:
        typeof v.accent === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.accent)
          ? v.accent
          : DEFAULT_APPEARANCE.accent,
      density: v.density === "compact" ? "compact" : "regular",
      radius:
        typeof v.radius === "number" && v.radius >= 6 && v.radius <= 26
          ? v.radius
          : DEFAULT_APPEARANCE.radius,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function serializeAppearance(a: Appearance): string {
  return encodeURIComponent(JSON.stringify(a));
}

// Client-only: read the appearance cookie (returns defaults during SSR).
export function readAppearanceCookie(): Appearance {
  if (typeof document === "undefined") return DEFAULT_APPEARANCE;
  const entry = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${APPEARANCE_COOKIE}=`));
  return parseAppearance(entry ? entry.split("=").slice(1).join("=") : null);
}

// Client-only: persist the appearance cookie.
export function writeAppearanceCookie(a: Appearance): void {
  if (typeof document === "undefined") return;
  document.cookie = `${APPEARANCE_COOKIE}=${serializeAppearance(a)}; path=/; max-age=${APPEARANCE_MAX_AGE}; SameSite=Lax`;
}
