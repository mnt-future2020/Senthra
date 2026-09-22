"use client";

import * as React from "react";
import { HardDrive, Cloud, Loader2, CheckCircle2, XCircle } from "lucide-react";

import * as settingsService from "@/services/settings.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useAuth } from "@/hooks/useAuth";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { ReadOnlyNotice } from "@/components/dashboard/settings/ui/ReadOnlyNotice";
import { Notice } from "@/components/ui/Notice";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Field } from "@/components/ui/Field";
import { inputCls, primaryBtn } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";

type Provider = "cloudinary" | "spaces";

const PROVIDER_LABEL: Record<Provider, string> = {
  cloudinary: "Cloudinary",
  spaces: "DigitalOcean Spaces",
};

/**
 * Settings → Storage — the ONE place every storage provider is configured.
 *
 * THREE CARDS, and the separation is the whole design:
 *
 *   1. ACTIVE PROVIDER — which one new uploads go to. Nothing else.
 *   2. CLOUDINARY      — its credentials, always editable and always testable.
 *   3. SPACES          — its credentials, always editable and always testable.
 *
 * CONFIGURING a provider and CHOOSING it are different acts, and each card saves itself. That is
 * not a style preference: an administrator has to be able to set up and verify a new provider while
 * the old one keeps running, and switch days later once they are satisfied. Hiding a provider's
 * fields behind the radio — as this page first did — made that impossible, and left "Test
 * connection" pointing at credentials the page would not show you.
 *
 * Because each card posts only its own fields, saving credentials CANNOT switch provider. The
 * guarantee is structural rather than a rule someone has to remember.
 */
export function StorageSection() {
  const { can } = useAuth();
  const canManage = can("settings.manage");
  const { pushToast } = useDashboard();

  // ── Active provider ──────────────────────────────────────────────────────────────────────────
  const [provider, setProvider] = React.useState<Provider>("cloudinary");
  const [savedProvider, setSavedProvider] = React.useState<Provider>("cloudinary");
  const [savingProvider, setSavingProvider] = React.useState(false);
  const [providerMsg, setProviderMsg] = React.useState<Msg>(null);
  /** The provider change awaiting confirmation. */
  const [pendingProvider, setPendingProvider] = React.useState<Provider | null>(null);

  // ── Cloudinary ───────────────────────────────────────────────────────────────────────────────
  const [cloudName, setCloudName] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [apiSecret, setApiSecret] = React.useState("");
  const [cloudinarySecretSet, setCloudinarySecretSet] = React.useState(false);
  const [cloudinaryConfigured, setCloudinaryConfigured] = React.useState(false);
  const [cloudinaryTest, setCloudinaryTest] = React.useState<settingsService.StorageTestResult | null>(null);
  const [testingCloudinary, setTestingCloudinary] = React.useState(false);
  const [savingCloudinary, setSavingCloudinary] = React.useState(false);
  const [cloudinaryMsg, setCloudinaryMsg] = React.useState<Msg>(null);

  // ── Spaces ───────────────────────────────────────────────────────────────────────────────────
  const [endpoint, setEndpoint] = React.useState("");
  const [region, setRegion] = React.useState("");
  const [bucket, setBucket] = React.useState("");
  const [accessKeyId, setAccessKeyId] = React.useState("");
  const [secretKey, setSecretKey] = React.useState("");
  const [cdnUrl, setCdnUrl] = React.useState("");
  const [spacesSecretSet, setSpacesSecretSet] = React.useState(false);
  const [spacesConfigured, setSpacesConfigured] = React.useState(false);
  const [spacesTest, setSpacesTest] = React.useState<settingsService.StorageTestResult | null>(null);
  const [testingSpaces, setTestingSpaces] = React.useState(false);
  const [savingSpaces, setSavingSpaces] = React.useState(false);
  const [spacesMsg, setSpacesMsg] = React.useState<Msg>(null);

  /**
   * Adopt the server's settings.
   *
   * `adoptProvider` is the one thing a caller chooses. The radio is a PENDING choice, and a
   * credential save must not throw it away: an administrator who selects Spaces, then saves the
   * Spaces credentials, would otherwise watch the radio jump back to Cloudinary. `savedProvider` —
   * what the server actually stores, and what the switch guard measures against — always follows.
   */
  const load = React.useCallback(
    (s: Awaited<ReturnType<typeof settingsService.getSettings>>, adoptProvider = false) => {
    if (adoptProvider) setProvider(s.storageProvider);
    setSavedProvider(s.storageProvider);
    setCloudName(s.cloudinaryCloudName);
    setApiKey(s.cloudinaryApiKey);
    setCloudinarySecretSet(s.cloudinaryApiSecretSet);
    setCloudinaryConfigured(s.cloudinaryConfigured);
    setEndpoint(s.spacesEndpoint);
    setRegion(s.spacesRegion);
    setBucket(s.spacesBucket);
    setAccessKeyId(s.spacesAccessKeyId);
    setCdnUrl(s.spacesCdnUrl);
    setSpacesSecretSet(s.spacesSecretKeySet);
    setSpacesConfigured(s.spacesConfigured);
    },
    [],
  );

  React.useEffect(() => {
    (async () => {
      try {
        load(await settingsService.getSettings(), true);
      } catch {
        // The cards render empty; each save path reports its own failure.
      }
    })();
  }, [load]);

  /** The values on screen for each provider — what a test and that card's save both judge. */
  const cloudinaryFields = () => ({
    cloudinaryCloudName: cloudName,
    cloudinaryApiKey: apiKey,
    ...(apiSecret ? { cloudinaryApiSecret: apiSecret } : {}),
  });
  const spacesFields = () => ({
    spacesEndpoint: endpoint,
    spacesRegion: region,
    spacesBucket: bucket,
    spacesAccessKeyId: accessKeyId,
    spacesCdnUrl: cdnUrl,
    ...(secretKey ? { spacesSecretKey: secretKey } : {}),
  });

  // Any edit invalidates that card's previous pass: what was verified is no longer what would be
  // saved. The server fingerprints the tested configuration and would refuse anyway; clearing the
  // tick here is what stops the UI showing a success that has stopped being true.
  const onEdit = (set: (v: string) => void, clear: () => void) => (v: string) => {
    clear();
    set(v);
  };
  const editCloudinary = (set: (v: string) => void) => onEdit(set, () => setCloudinaryTest(null));
  const editSpaces = (set: (v: string) => void) => onEdit(set, () => setSpacesTest(null));

  const runTest = async (
    which: Provider,
    setBusy: (b: boolean) => void,
    setResult: (r: settingsService.StorageTestResult) => void,
  ) => {
    setBusy(true);
    try {
      setResult(
        await settingsService.testStorage({
          provider: which,
          ...(which === "cloudinary" ? cloudinaryFields() : spacesFields()),
        }),
      );
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "The test could not be run." });
    } finally {
      setBusy(false);
    }
  };

  /** One card's save. The payload carries ONLY that card's fields, so it cannot switch provider. */
  const saveCard = async (
    payload: Parameters<typeof settingsService.updateSettings>[0],
    setBusy: (b: boolean) => void,
    setMsg: (m: Msg) => void,
    toast: string,
    opts: { adoptProvider?: boolean; after?: () => void } = {},
  ) => {
    setMsg(null);
    setBusy(true);
    try {
      load(await settingsService.updateSettings(payload), opts.adoptProvider);
      opts.after?.();
      pushToast(toast);
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Save failed." });
    } finally {
      setBusy(false);
    }
  };

  const persistProvider = async (next: Provider) => {
    await saveCard({ storageProvider: next }, setSavingProvider, setProviderMsg, "Active storage provider saved.", {
      adoptProvider: true,
    });
    // `saveCard` swallows the failure into `providerMsg`, so this runs either way — the dialog
    // closes and the error stays on the card, the same shape as the 2FA confirmation.
    setPendingProvider(null);
  };

  const switchingToSpaces = provider === "spaces" && savedProvider !== "spaces";
  const blockedBySwitchGuard = switchingToSpaces && spacesTest?.ok !== true;

  const targetProvider = pendingProvider ?? provider;
  const targetConfigured = targetProvider === "spaces" ? spacesConfigured : cloudinaryConfigured;

  const chip = (label: string, ok: boolean) => (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider ${
        ok
          ? "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]"
          : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-[var(--pos)]" : "bg-[var(--faint)]"}`} />
      {label}
    </span>
  );

  const testRow = (
    id: string,
    label: string,
    busy: boolean,
    result: settingsService.StorageTestResult | null,
    onRun: () => void,
  ) => (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={onRun} disabled={busy} className={primaryBtn} data-testid={`${id}-test`}>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {label}
      </button>
      {result && (
        <span
          data-testid={`${id}-test-result`}
          className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
            result.ok ? "text-[var(--pos)]" : "text-[var(--neg)]"
          }`}
        >
          {result.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {result.message}
        </span>
      )}
    </div>
  );

  return (
    <>
      {/* ── 1. Which provider new uploads go to ───────────────────────────────────────────────── */}
      <SettingsCard
        icon={HardDrive}
        title="Active storage provider"
        badge={chip(
          PROVIDER_LABEL[savedProvider],
          savedProvider === "spaces" ? spacesConfigured : cloudinaryConfigured,
        )}
        desc="Where new uploads are stored. Files already uploaded stay where they are and keep working."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // Only a real CHANGE is worth a question. Re-saving the provider already in force does
            // nothing, and a dialog there would be noise — which is exactly what trains people to
            // click through the one that matters.
            if (provider === savedProvider) void persistProvider(provider);
            else setPendingProvider(provider);
          }}
          className="space-y-4"
        >
          {!canManage && <ReadOnlyNotice />}
          <fieldset disabled={!canManage} className="min-w-0 space-y-4">
            <Field
              label="Active provider"
              hint="Applies to NEW uploads only. Existing files remain on the provider that stored them and are never moved."
            >
              <div className="space-y-2">
                {(
                  [
                    ["cloudinary", PROVIDER_LABEL.cloudinary, "Media CDN with delivery-time image transformations."],
                    ["spaces", PROVIDER_LABEL.spaces, "S3-compatible object storage, with an optional CDN."],
                  ] as const
                ).map(([value, label, blurb]) => (
                  <label
                    key={value}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--border)] p-3 hover:bg-[var(--surface-2)]"
                  >
                    <input
                      type="radio"
                      name="storageProvider"
                      value={value}
                      checked={provider === value}
                      onChange={() => setProvider(value)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{label}</span>
                      <span className="block text-xs text-[var(--muted)]">{blurb}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Field>

            {blockedBySwitchGuard && (
              <Notice
                msg={{
                  type: "info",
                  text: "Test the DigitalOcean Spaces connection below before making it the active storage provider.",
                }}
              />
            )}
            <Notice msg={providerMsg} />

            <div className="flex justify-end">
              <button type="submit" disabled={savingProvider || blockedBySwitchGuard} className={primaryBtn}>
                {savingProvider && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save active provider
              </button>
            </div>
          </fieldset>
        </form>
      </SettingsCard>

      {/* ── 2. Cloudinary — editable and testable whichever provider is active ────────────────── */}
      <SettingsCard
        icon={Cloud}
        title="Cloudinary"
        badge={chip(cloudinaryConfigured ? "Connected" : "Not set up", cloudinaryConfigured)}
        desc="Credentials are in your Cloudinary dashboard. Editing these never changes which provider is active."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveCard(cloudinaryFields(), setSavingCloudinary, setCloudinaryMsg, "Cloudinary settings saved.", {
              after: () => setApiSecret(""),
            });
          }}
          className="space-y-4"
        >
          {!canManage && <ReadOnlyNotice />}
          <fieldset disabled={!canManage} className="min-w-0 space-y-4">
            <Field label="Cloud name" hint="From your Cloudinary dashboard.">
              <input
                type="text"
                value={cloudName}
                onChange={(e) => editCloudinary(setCloudName)(e.target.value)}
                placeholder="your-cloud-name"
                autoComplete="off"
                className={inputCls}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="API key" hint="Your public Cloudinary API key.">
                <input
                  type="text"
                  value={apiKey}
                  onChange={(e) => editCloudinary(setApiKey)(e.target.value)}
                  placeholder="123456789012345"
                  autoComplete="off"
                  className={inputCls}
                />
              </Field>
              <Field
                label="API secret"
                hint={
                  cloudinarySecretSet
                    ? "Saved — leave blank to keep. Stored encrypted, never shown again."
                    : "Stored encrypted, never shown again."
                }
              >
                <PasswordInput
                  value={apiSecret}
                  onChange={(e) => editCloudinary(setApiSecret)(e.target.value)}
                  placeholder={cloudinarySecretSet ? "•••••••• (saved)" : "API secret"}
                  autoComplete="off"
                />
              </Field>
            </div>

            {testRow("cloudinary", "Test connection", testingCloudinary, cloudinaryTest, () =>
              void runTest("cloudinary", setTestingCloudinary, setCloudinaryTest),
            )}
            <Notice msg={cloudinaryMsg} />

            <div className="flex justify-end">
              <button type="submit" disabled={savingCloudinary} className={primaryBtn}>
                {savingCloudinary && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save Cloudinary settings
              </button>
            </div>
          </fieldset>
        </form>
      </SettingsCard>

      {/* ── 3. Spaces — editable and testable whichever provider is active ────────────────────── */}
      <SettingsCard
        icon={HardDrive}
        title="DigitalOcean Spaces"
        badge={chip(spacesConfigured ? "Connected" : "Not set up", spacesConfigured)}
        desc="S3-compatible object storage. Set it up and test it here first; make it active above when you are ready."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveCard(spacesFields(), setSavingSpaces, setSpacesMsg, "DigitalOcean Spaces settings saved.", {
              after: () => setSecretKey(""),
            });
          }}
          className="space-y-4"
        >
          {!canManage && <ReadOnlyNotice />}
          <fieldset disabled={!canManage} className="min-w-0 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Endpoint" hint="e.g. https://ams3.digitaloceanspaces.com">
                <input
                  type="text"
                  value={endpoint}
                  onChange={(e) => editSpaces(setEndpoint)(e.target.value)}
                  placeholder="https://ams3.digitaloceanspaces.com"
                  autoComplete="off"
                  className={inputCls}
                />
              </Field>
              <Field label="Region" hint="e.g. ams3">
                <input
                  type="text"
                  value={region}
                  onChange={(e) => editSpaces(setRegion)(e.target.value)}
                  placeholder="ams3"
                  autoComplete="off"
                  className={inputCls}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Bucket" hint="The Space's name.">
                <input
                  type="text"
                  value={bucket}
                  onChange={(e) => editSpaces(setBucket)(e.target.value)}
                  autoComplete="off"
                  className={inputCls}
                />
              </Field>
              <Field label="CDN URL" hint="Optional. Files are served from here when set.">
                <input
                  type="text"
                  value={cdnUrl}
                  onChange={(e) => editSpaces(setCdnUrl)(e.target.value)}
                  placeholder="https://files.example.com"
                  autoComplete="off"
                  className={inputCls}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Access key ID" hint="From your DigitalOcean Spaces keys.">
                <input
                  type="text"
                  value={accessKeyId}
                  onChange={(e) => editSpaces(setAccessKeyId)(e.target.value)}
                  autoComplete="off"
                  className={inputCls}
                />
              </Field>
              <Field
                label="Secret key"
                hint={
                  spacesSecretSet
                    ? "Saved — leave blank to keep. Stored encrypted, never shown again."
                    : "Stored encrypted, never shown again."
                }
              >
                <PasswordInput
                  value={secretKey}
                  onChange={(e) => editSpaces(setSecretKey)(e.target.value)}
                  placeholder={spacesSecretSet ? "•••••••• (saved)" : "Secret key"}
                  autoComplete="off"
                />
              </Field>
            </div>

            {testRow("spaces", "Test connection", testingSpaces, spacesTest, () =>
              void runTest("spaces", setTestingSpaces, setSpacesTest),
            )}
            <Notice msg={spacesMsg} />

            <div className="flex justify-end">
              <button type="submit" disabled={savingSpaces} className={primaryBtn}>
                {savingSpaces && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save DigitalOcean Spaces settings
              </button>
            </div>
          </fieldset>
        </form>
      </SettingsCard>

      {/*
        A DIFFERENT question from the switch guard above, which is why both exist. The guard asks
        "does this configuration actually work?"; this asks "do you mean for new uploads to start
        going somewhere else?" A switch is reversible in one click, but its EFFECTS are not — every
        file uploaded in the meantime stays on the provider that took it, so each switch permanently
        splits the corpus across two providers. That is the consequence worth naming here, at the
        moment of the decision, rather than in hint text already scrolled past.
      */}
      <ConfirmDialog
        open={pendingProvider !== null}
        danger={!targetConfigured}
        busy={savingProvider}
        title="Change active storage provider?"
        confirmLabel="Change provider"
        message={
          <span className="space-y-2">
            {/*
              Switching BACK to Cloudinary is ungated by design — the way back must always stay
              open — so this warning is the only thing standing between an install that has run on
              Spaces for months and a return to credentials nobody has checked since. It informs;
              it does not block.
            */}
            {!targetConfigured && (
              <span className="block font-semibold">
                {PROVIDER_LABEL[targetProvider]} is not configured. New uploads may fail until it is
                configured.
              </span>
            )}
            <span className="block">
              Existing files will remain on the provider where they were originally stored and will not be
              migrated.
            </span>
            <span className="block">New uploads will use {PROVIDER_LABEL[targetProvider]} from now on.</span>
          </span>
        }
        onConfirm={() => void persistProvider(targetProvider)}
        onClose={() => setPendingProvider(null)}
      />
    </>
  );
}
