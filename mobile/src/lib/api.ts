import * as SecureStore from "expo-secure-store";

// Thin fetch wrapper mirroring the web frontend's lib/api.ts.
//
// Auth model (no backend changes needed):
// - POST /auth/login returns { token } AND sets httpOnly cookies; React Native's native
//   networking stores + resends those cookies automatically.
// - We ALSO keep the access token in SecureStore and send it as `Authorization: Bearer`
//   as a fallback (the backend reads the cookie first, then the Bearer header).
// - On a 401 we call POST /auth/refresh once (the refresh cookie rides along natively),
//   store the fresh token from the response body, and replay the original request.

const BASE = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/+$/, "");
const TOKEN_KEY = "senthra_access_token";
const DEFAULT_TIMEOUT = 20_000;
const NO_REFRESH = ["/auth/refresh", "/auth/login"];

let accessToken: string | null = null;
let hydrated = false;

/** Load the persisted access token into memory (idempotent; call before first request). */
export async function hydrateToken(): Promise<string | null> {
  if (!hydrated) {
    try {
      accessToken = await SecureStore.getItemAsync(TOKEN_KEY);
    } catch {
      accessToken = null;
    }
    hydrated = true;
  }
  return accessToken;
}

export async function setAccessToken(token: string | null): Promise<void> {
  accessToken = token;
  hydrated = true;
  try {
    if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // Persisting is best-effort — the in-memory token still works for this session.
  }
}

export function getAccessToken(): string | null {
  return accessToken;
}

export class ApiError extends Error {
  status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isPermissionError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

// Fired when a request ends 401 even after the silent refresh — the session is
// truly dead (refresh token expired / revoked). The auth layer registers a
// handler that clears the principal so the router falls back to the login page.
let onAuthFailure: (() => void) | null = null;
export function setOnAuthFailure(handler: (() => void) | null): void {
  onAuthFailure = handler;
}

// One refresh at a time — a burst of expired-token requests triggers a single refresh.
let refreshInFlight: Promise<boolean> | null = null;

async function attemptRefresh(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) return false;
      const data = (await res.json().catch(() => null)) as { token?: string } | null;
      if (data?.token) await setAccessToken(data.token);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  timeout?: number;
}

export async function api<T>(path: string, options: ApiOptions = {}, _retried = false): Promise<T> {
  await hydrateToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout ?? DEFAULT_TIMEOUT);

  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new ApiError("The request timed out. Please try again.", null);
    }
    throw new ApiError("Could not reach the server. Check your connection.", null);
  }
  clearTimeout(timer);

  if (res.status === 401 && !_retried && !NO_REFRESH.some((p) => path.startsWith(p))) {
    const ok = await attemptRefresh();
    if (ok) return api<T>(path, options, true);
  }

  // Still 401 after the refresh path (or on the retried request): the session is
  // dead — tell the auth layer so the app returns to the login screen. Login
  // itself is excluded (a wrong password must not look like an expired session).
  if (res.status === 401 && !NO_REFRESH.some((p) => path.startsWith(p))) {
    onAuthFailure?.();
  }

  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    const message = data?.error ?? `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

/** Build a query string from defined, non-empty params (mirrors the web services' helper). */
export function qs(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}
