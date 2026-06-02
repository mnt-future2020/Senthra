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
      const data = err.response?.data as { error?: string } | undefined;
      if (data?.error) throw new Error(data.error);
      if (err.response) throw new Error(`Request failed (${err.response.status})`);
      if (err.code === "ECONNABORTED")
        throw new Error("The request timed out. Please try again.");
      if (err.code === "ERR_NETWORK")
        throw new Error("Could not reach the server. Check your connection.");
      throw new Error(err.message);
    }
    throw err;
  }
}
