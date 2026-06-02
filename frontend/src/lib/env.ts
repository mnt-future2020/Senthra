/**
 * Centralized, validated access to public environment variables.
 *
 * NEXT_PUBLIC_* vars are inlined at build time, so reference them by their
 * full literal name (not via a dynamic key) for Next.js to replace them.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL;

if (!API_URL) {
  throw new Error(
    "Missing NEXT_PUBLIC_API_URL. Add it to frontend/.env (see .env.example).",
  );
}

export const env = {
  /** Base URL of the backend API, e.g. http://localhost:8000 */
  apiUrl: API_URL,
} as const;
