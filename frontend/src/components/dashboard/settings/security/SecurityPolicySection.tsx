"use client";

import * as React from "react";
import { KeyRound } from "lucide-react";

import * as settingsService from "@/services/settings.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { ReadOnlyNotice } from "@/components/dashboard/settings/ui/ReadOnlyNotice";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Notice } from "@/components/ui/Notice";
import { Toggle } from "@/components/dashboard/settings/ui/Toggle";
import { hintCls } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";
import type { Settings } from "@/types/settings";

/**
 * Global sign-in policy.
 *
 * Distinct from Settings → My Account, which is the super-admin's OWN credentials: this card
 * changes how EVERY account authenticates, so it sits behind settings.manage rather than being
 * admin-only.
 *
 * Layout follows OperationsSection (the other single-toggle card): short two-word title, one
 * bordered toggle row, standing explanation as hint text, and the Notice reserved for errors.
 */
export function SecurityPolicySection() {
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const canManage = can("settings.manage");

  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [enabled, setEnabled] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  /**
   * Whether the first read has come back — NOT merely whether it succeeded.
   *
   * Until it has, this card knows nothing, and the defaults it would otherwise render (off, no
   * SMTP) are not neutral placeholders like the ones on the other tabs: they state that mail is
   * unconfigured and that 2FA is off. An admin whose SMTP is set up and whose 2FA is ON opened this
   * card and was told, for as long as the request took, the exact opposite of the truth — about the
   * one setting on the page that can lock an entire company out. Say nothing until we know.
   */
  const [loaded, setLoaded] = React.useState(false);
  // ERRORS ONLY. A failure has to stay on screen until it is fixed; the success is a moment and
  // goes to a toast. Same rule as every other settings card.
  const [msg, setMsg] = React.useState<Msg>(null);

  // The pending change awaiting confirmation.
  const [pending, setPending] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const s = await settingsService.getSettings();
        setSettings(s);
        setEnabled(s.emailTwoFactorEnabled);
      } catch {
        // ignore — keep defaults; the save below surfaces any real problem
      } finally {
        // `finally`, so a failed read stops waiting too: the card falls back to its defaults and
        // the toggle becomes usable, rather than sitting disabled with a spinner for ever.
        setLoaded(true);
      }
    })();
  }, []);

  // The same completeness test the server applies. Mirrored here only to explain the disabled
  // toggle — the server enforces it regardless of what this UI does.
  const smtpReady = Boolean(
    settings?.smtpHost && settings?.smtpPort && settings?.smtpFromEmail && settings?.smtpPasswordSet,
  );

  const persist = async (next: boolean) => {
    setMsg(null);
    setSaving(true);
    try {
      const updated = await settingsService.updateSettings({ emailTwoFactorEnabled: next });
      setSettings(updated);
      setEnabled(updated.emailTwoFactorEnabled);
      pushToast(next ? "Two-factor authentication is on." : "Two-factor authentication is off.");
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Save failed." });
    } finally {
      setPending(null);
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsCard
        icon={KeyRound}
        title="Two-Factor Sign-In"
        desc="Require a one-time code, emailed to the account address, at every sign-in."
      >
        <div className="space-y-4">
          {!canManage && <ReadOnlyNotice />}
          <fieldset disabled={!canManage || saving} className="min-w-0 space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3.5">
              <div className="min-w-0">
                <span className="block text-sm font-bold text-[var(--ink)]">
                  Require a code at sign-in
                </span>
                <span className="mt-0.5 block text-xs text-[var(--muted)]">
                  {!loaded
                    ? "Checking the current policy…"
                    : enabled
                      ? "Everyone must enter a 6-digit code emailed to them, however they sign in."
                      : "Turn on to add an emailed code to every sign-in."}
                </span>
              </div>
              <Toggle
                checked={enabled}
                // Saves behind a confirmation rather than a Save button: it is one switch, and a
                // security policy left half-changed because someone forgot to press Save is worse
                // than one extra dialog.
                onChange={setPending}
                // Set on the control itself as well as on the fieldset: a fieldset disables its
                // descendants for interaction, but `button.disabled` does not reflect an ancestor
                // fieldset, so screen readers would still announce this switch as available.
                // Enabling without a working mail server would lock every user out — including
                // whoever would need to turn it back off. Turning it OFF is never blocked.
                disabled={!canManage || saving || !loaded || (!enabled && !smtpReady)}
                aria-label="Require a code at sign-in"
              />
            </div>

            {/* One or two lines, like the hints on the other tabs — the card's own description above
                already says what the setting does, so this covers only the consequences. */}
            {/* A non-breaking space while loading, not an empty node: it holds the line's height so
                the real hint appears in place instead of shoving the Notice below it down the card
                — the same reason the login page reserves the Google button's box. */}
            <p className={hintCls}>
              {!loaded
                ? " "
                : !enabled && !smtpReady
                  ? "Set up SMTP under Settings → Email first — without it, nobody could receive a code."
                  : "Applies at each person's next sign-in; anyone already signed in stays signed in. Google Sign-In keeps working and asks for the code too."}
            </p>

            <Notice msg={msg} />
          </fieldset>
        </div>
      </SettingsCard>

      {/* The app's own dialog, not window.confirm — same as every other confirmation in the app, and
          the only one that is reachable by keyboard and announced to a screen reader. */}
      <ConfirmDialog
        open={pending !== null}
        danger={pending === false}
        busy={saving}
        title={pending ? "Turn on two-factor authentication?" : "Turn off two-factor authentication?"}
        confirmLabel={pending ? "Turn on" : "Turn off"}
        message={
          pending
            ? "Everyone will need a code emailed to them — including people who sign in with Google. People already signed in stay signed in."
            : "Everyone will sign in with just an email and password, or with Google, and no code will be asked for."
        }
        onConfirm={() => void persist(pending!)}
        onClose={() => setPending(null)}
      />

    </>
  );
}
