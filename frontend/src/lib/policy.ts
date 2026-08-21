import { cache } from "react";

import type { PublicPolicy } from "@/types/policy";
import { env } from "./env";

/**
 * Server-side fetch of the PUBLISHED privacy policy, for the /privacy page.
 *
 * Mirrors `lib/branding.ts`: fetched during SSR so the page renders with its content on first paint
 * and works for a signed-out visitor, `no-store` so a newly published version appears on the next
 * request, and wrapped in React.cache so repeated calls in one render pass share a request.
 *
 * Returns null in all three "no policy to show" cases — nothing published, the backend unreachable,
 * an unexpected response — and the page renders the same unavailable state for each. It NEVER falls
 * back to any other content: there is no draft on this path to fall back to, and a placeholder that
 * looked like a policy would be worse than an honest blank.
 */
export const fetchPublishedPolicy = cache(async (): Promise<PublicPolicy | null> => {
  try {
    const res = await fetch(`${env.apiUrl}/policies/privacy`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { policy?: PublicPolicy | null };
    return data.policy ?? null;
  } catch {
    return null;
  }
});
