import axios, {
  AxiosError,
  type InternalAxiosRequestConfig,
  type Method,
} from "axios";

import { env } from "./env";

type ApiOptions = {
  method?: Method;
  body?: unknown;
  headers?: Record<string, string>;
  // Per-request timeout override (ms). Defaults to DEFAULT_TIMEOUT below.
  timeout?: number;
};

/**
 * Error thrown by `api()` / `apiBlob()` for a failed request. Extends `Error` (so every existing
 * `instanceof Error` / `err.message` caller keeps working unchanged) and additionally carries the
 * HTTP `status` when the server responded — `null` for network/timeout failures with no response.
 * Lets callers distinguish a permission wall (403) from a genuine server error without string-matching.
 */
export class ApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// True when an error is a permission/auth wall (403 Forbidden). 401 is excluded — the interceptor
// silently refreshes and retries those, so a surfaced 401 is rare and not a "you lack permission" case.
export function isPermissionError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

// Fail fast on a hung backend instead of spinning forever. SMTP-heavy calls
// (e.g. sending a test email) can override this with a longer value.
const DEFAULT_TIMEOUT = 20_000;

// Axios instance — always sends the httpOnly auth cookies and JSON by default.
const client = axios.create({
  baseURL: env.apiUrl,
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

// Endpoints that must NOT trigger a silent refresh-and-retry on a 401.
const NO_REFRESH = ["/auth/refresh", "/auth/login", "/auth/google"];

// De-duped silent refresh: many concurrent 401s share one /auth/refresh call.
let refreshInFlight: Promise<boolean> | null = null;
function attemptRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = client
      .post("/auth/refresh")
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

// On a 401 (expired access token), refresh once then replay the original request.
client.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as
      | (InternalAxiosRequestConfig & { _retried?: boolean })
      | undefined;
    const url = original?.url ?? "";

    if (
      error.response?.status === 401 &&
      original &&
      !original._retried &&
      !NO_REFRESH.some((p) => url.startsWith(p))
    ) {
      original._retried = true;
      if (await attemptRefresh()) return client(original);
    }
    return Promise.reject(error);
  },
);

/**
 * Thin wrapper around the backend API.
 * - Sends httpOnly auth cookies (`withCredentials`)
 * - Silently refreshes once on a 401 and retries (via the interceptor above)
 * - Throws an Error carrying the server's message on non-2xx responses
 */
export async function api<T = unknown>(
  path: string,
  options: ApiOptions = {},
): Promise<T> {
  try {
    const res = await client.request<T>({
      url: path,
      method: options.method ?? "GET",
      data: options.body,
      headers: options.headers,
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
    });
    return res.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status ?? null;
      const data = err.response?.data as { error?: string } | undefined;
      if (data?.error) throw new ApiError(data.error, status);
      if (err.response) throw new ApiError(`Request failed (${err.response.status})`, status);
      if (err.code === "ECONNABORTED")
        throw new ApiError("The request timed out. Please try again.", null);
      if (err.code === "ERR_NETWORK")
        throw new ApiError("Could not reach the server. Check your connection.", null);
      throw new ApiError(err.message, status);
    }
    throw err;
  }
}

/**
 * Fetch a binary response (e.g. a generated PDF) as a Blob. Sends the auth cookies and shares the
 * silent-refresh interceptor, like `api()`. Uses a longer default timeout since document generation
 * (logo/signature fetch + render) can take a little longer than a JSON call.
 */
export async function apiBlob(path: string, timeout = 60_000): Promise<Blob> {
  try {
    const res = await client.request<Blob>({
      url: path,
      method: "GET",
      responseType: "blob",
      timeout,
    });
    return res.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      if (err.code === "ECONNABORTED")
        throw new ApiError("The request timed out. Please try again.", null);
      if (err.code === "ERR_NETWORK")
        throw new ApiError("Could not reach the server. Check your connection.", null);
      throw new ApiError(`Request failed${err.response ? ` (${err.response.status})` : ""}.`, err.response?.status ?? null);
    }
    throw err;
  }
}
