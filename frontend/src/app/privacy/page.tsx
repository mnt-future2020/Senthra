import type { Metadata } from "next";
import Link from "next/link";

import { fetchPublishedPolicy } from "@/lib/policy";
import { PolicyBlocks } from "@/components/policy/PolicyBlocks";

/**
 * The public privacy notice.
 *
 * Renders the PUBLISHED policy and nothing else. The content is managed in the dashboard
 * (Settings → Privacy Policy) and published by someone holding `policy.publish`; no policy text is shipped
 * in this file, and there is no fallback that could put an unapproved draft on screen — when
 * nothing is published this page says so.
 *
 * Publicly reachable and indexable, on purpose. This page is linked from the sign-in screen
 * (components/auth/AuthLayout.tsx) because that is the point of collection, and a data-protection
 * notice that cannot be found is not serving its purpose.
 *
 * It carried `robots: { index: false, follow: false }` while the page still rendered hardcoded draft
 * text, so an unapproved document could not be surfaced by a search engine. That guard belonged to a
 * page that no longer exists: the content is now whatever an operator holding `policy.publish` chose
 * to publish, and nothing is on screen that somebody did not deliberately put there.
 *
 * If this page shows "no policy published", the fix is to publish one in Settings → Privacy Policy —
 * not to unlink or de-index the page.
 */

export const metadata: Metadata = {
  title: "Privacy Notice",
  description: "How this service collects and uses personal information.",
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
