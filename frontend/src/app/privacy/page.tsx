import type { Metadata } from "next";
import Link from "next/link";

import { fetchPublishedPolicy } from "@/lib/policy";
import { PolicyBlocks } from "@/components/policy/PolicyBlocks";

/**
 * The public privacy notice.
 *
 * Renders the PUBLISHED policy and nothing else. The content is managed in the dashboard
 * (Settings → Legal) and published by someone holding `policy.publish`; no policy text is shipped
 * in this file, and there is no fallback that could put an unapproved draft on screen — when
 * nothing is published this page says so.
 *
 * ── THE TWO MANUAL SWITCHES ────────────────────────────────────────────────────────────────────
 * Publishing does NOT make this page discoverable, deliberately. Once the client has approved the
 * published version, two edits are required — both by hand, so that going public is a decision
 * someone takes rather than a side effect of a database write:
 *
 *   1. HERE — delete the `robots` line from the metadata below.
 *   2. In `components/auth/AuthLayout.tsx` — restore the sign-in footer link (the exact markup is
 *      in the comment that replaced it).
 *
 * Until both are done the notice is reachable only by direct URL, which is what allows it to be
 * reviewed without being announced.
 */

export const metadata: Metadata = {
  title: "Privacy Notice",
  description: "How this service collects and uses personal information.",
  // MANUAL SWITCH 1 of 2 — remove once the client has approved the published policy. See above.
  robots: { index: false, follow: false },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default async function PrivacyPage() {
  const policy = await fetchPublishedPolicy();

  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-[var(--accent)]">
        Data protection
      </p>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-[var(--ink)]">
        Privacy notice
      </h1>

      {policy ? (
        <>
          <p className="mt-3 text-xs text-[var(--faint)]">
            Version {policy.version} · Published {formatDate(policy.publishedAt)}
          </p>
          <div className="mt-8">
            <PolicyBlocks blocks={policy.blocks} />
          </div>
        </>
      ) : (
        /*
         * Nothing published — also what a reader sees if the backend is unreachable. One honest
         * state for both: this page never guesses, and never shows content that has not been
         * approved for publication.
         */
        <div className="mt-8 border border-[var(--border-2)] bg-[var(--surface-2)] p-6">
          <p className="text-sm font-bold text-[var(--ink)]">Not available yet</p>
          <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
            A privacy notice has not been published for this service yet. If you need information
            about how your personal data is handled, please contact your administrator.
          </p>
        </div>
      )}

      <div className="mt-12 border-t border-[var(--border-2)] pt-6 text-xs text-[var(--faint)]">
        <Link href="/login" className="font-semibold text-[var(--accent)] hover:underline">
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
