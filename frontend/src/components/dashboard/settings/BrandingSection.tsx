"use client";

import * as React from "react";
import { Image as ImageIcon, Loader2, Paintbrush, Trash2, Upload } from "lucide-react";

import { useBranding } from "@/hooks/useBranding";
import { useAuth } from "@/hooks/useAuth";
import * as brandingService from "@/services/branding.service";
import * as settingsService from "@/services/settings.service";
import type { Branding, Settings } from "@/types/settings";
import { SettingsCard } from "./ui/SettingsCard";
import { ReadOnlyNotice } from "./ui/ReadOnlyNotice";
import { Notice } from "./ui/Notice";
import { Field } from "./ui/Field";
import { inputCls, labelCls } from "./ui/styles";
import { SaveBar } from "./ui/SaveBar";
import type { Msg } from "./types";
import { useReportDirty } from "@/providers/NavigationGuardProvider";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB — logos/favicons are tiny

// The brand accent applied when none is chosen. Kept in sync with the backend's
// DEFAULT_BRAND_COLOR (backend/src/utils/email-html.ts) so the UI and sent emails
// agree on the fallback.
const DEFAULT_BRAND_COLOR = "#7b6ef0";

// Image types the backend accepts. Mirrors the upload validation server-side so
// the user gets an instant, friendly rejection instead of a round-trip error.
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

function brandingFromSettings(s: Settings): Branding {
  return {
    brandName: s.brandName,
    brandColor: s.brandColor,
    logoUrl: s.logoUrl,
    faviconUrl: s.faviconUrl,
    footerText: s.footerText,
    loginHeadline: s.loginHeadline,
    loginSubtext: s.loginSubtext,
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

// Reusable preview + upload/remove control for logo & favicon.
function ImageUploader({
  title,
  hint,
  url,
  uploading,
  onPick,
  onRemove,
}: {
  title: string;
  hint: string;
  url: string;
  uploading: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div>
      <label className={labelCls}>{title}</label>
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-2)]">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={title} className="h-full w-full object-contain" />
          ) : (
            <ImageIcon className="h-6 w-6 text-[var(--faint)]" />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-60"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {url ? "Replace" : "Upload"}
            </button>
            {url && (
              <button
                type="button"
                onClick={onRemove}
                disabled={uploading}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-[var(--muted)] transition-all hover:text-[var(--neg)] disabled:opacity-60"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </button>
            )}
          </div>
          <span className="text-[11px] leading-tight text-[var(--faint)]">{hint}</span>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

export function BrandingSection() {
  const { setBranding } = useBranding();
  const { can } = useAuth();
  const canManage = can("settings.manage");

  const [brandName, setBrandName] = React.useState("");
  const [brandColor, setBrandColor] = React.useState(DEFAULT_BRAND_COLOR);
  const [logoUrl, setLogoUrl] = React.useState("");
  const [faviconUrl, setFaviconUrl] = React.useState("");
  const [footerText, setFooterText] = React.useState("");
  const [loginHeadline, setLoginHeadline] = React.useState("");
  const [loginSubtext, setLoginSubtext] = React.useState("");
  const [employeeIdPrefix, setEmployeeIdPrefix] = React.useState("");

  // Snapshot of the last-persisted text fields. Logo & favicon save immediately
  // on upload/remove, so they aren't part of this form's unsaved state — only
  // these text fields are. Drives the dirty check + the leave-without-saving guard.
  const [saved, setSaved] = React.useState({
    brandName: "",
    brandColor: DEFAULT_BRAND_COLOR,
    footerText: "",
    loginHeadline: "",
    loginSubtext: "",
    employeeIdPrefix: "",
  });

  const isDirty =
    brandName !== saved.brandName ||
    brandColor !== saved.brandColor ||
    footerText !== saved.footerText ||
    loginHeadline !== saved.loginHeadline ||
    loginSubtext !== saved.loginSubtext ||
    employeeIdPrefix !== saved.employeeIdPrefix;

  useReportDirty("branding", isDirty);

  const [saving, setSaving] = React.useState(false);
  const [uploading, setUploading] = React.useState<"logo" | "favicon" | null>(null);
  const [msg, setMsg] = React.useState<Msg>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const s = await settingsService.getSettings();
        setBrandName(s.brandName);
        setBrandColor(s.brandColor);
        setLogoUrl(s.logoUrl);
        setFaviconUrl(s.faviconUrl);
        setFooterText(s.footerText);
        setLoginHeadline(s.loginHeadline);
        setLoginSubtext(s.loginSubtext);
        setEmployeeIdPrefix(s.employeeIdPrefix);
        setSaved({
          brandName: s.brandName,
          brandColor: s.brandColor,
          footerText: s.footerText,
          loginHeadline: s.loginHeadline,
          loginSubtext: s.loginSubtext,
          employeeIdPrefix: s.employeeIdPrefix,
        });
      } catch {
        // ignore — leave fields blank
      }
    })();
  }, []);

  const handleUpload = async (type: "logo" | "favicon", file: File) => {
    setMsg(null);
    // `accept="image/*"` is only a picker hint — guard the real type here. (An
    // empty type is allowed through; the backend still validates the data URI.)
    if (file.type && !ALLOWED_IMAGE_TYPES.has(file.type)) {
      setMsg({
        type: "error",
        text: "Unsupported file. Use a PNG, JPG, GIF, WEBP, SVG or ICO image.",
      });
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setMsg({ type: "error", text: "Image must be under 2 MB." });
      return;
    }
    setUploading(type);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const { url, settings } = await brandingService.uploadBrandingImage(type, dataUrl);
      if (type === "logo") setLogoUrl(url);
      else setFaviconUrl(url);
      setBranding(brandingFromSettings(settings));
      setMsg({
        type: "success",
        text: `${type === "logo" ? "Logo" : "Favicon"} uploaded.`,
      });
    } catch (err) {
      setMsg({
        type: "error",
        text: err instanceof Error ? err.message : "Upload failed.",
      });
    } finally {
      setUploading(null);
    }
  };

  const handleRemove = async (type: "logo" | "favicon") => {
    setMsg(null);
    setUploading(type);
    try {
      const settings = await settingsService.updateSettings(
        type === "logo" ? { logoUrl: "" } : { faviconUrl: "" },
      );
      if (type === "logo") setLogoUrl("");
      else setFaviconUrl("");
      setBranding(brandingFromSettings(settings));
    } catch (err) {
      setMsg({
        type: "error",
        text: err instanceof Error ? err.message : "Remove failed.",
      });
    } finally {
      setUploading(null);
    }
  };

  const saveText = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    // Empty is allowed (resets to the default); otherwise enforce 2–5 letters so the
    // user gets an instant message instead of a round-trip 400.
    if (employeeIdPrefix && !/^[A-Z]{2,5}$/.test(employeeIdPrefix)) {
      setMsg({ type: "error", text: "Employee ID prefix must be 2–5 letters." });
      return;
    }
    setSaving(true);
    try {
      const settings = await settingsService.updateSettings({
        brandName,
        brandColor,
        footerText,
        loginHeadline,
        loginSubtext,
        employeeIdPrefix,
      });
      setBranding(brandingFromSettings(settings));
      setBrandName(settings.brandName);
      setBrandColor(settings.brandColor);
      setFooterText(settings.footerText);
      setLoginHeadline(settings.loginHeadline);
      setLoginSubtext(settings.loginSubtext);
      setEmployeeIdPrefix(settings.employeeIdPrefix);
      setSaved({
        brandName: settings.brandName,
        brandColor: settings.brandColor,
        footerText: settings.footerText,
        loginHeadline: settings.loginHeadline,
        loginSubtext: settings.loginSubtext,
        employeeIdPrefix: settings.employeeIdPrefix,
      });
      setMsg({ type: "success", text: "Branding saved." });
    } catch (err) {
      setMsg({
        type: "error",
        text: err instanceof Error ? err.message : "Save failed.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      icon={Paintbrush}
      title="Branding"
      desc="Make the app your own — brand name, logo, favicon, footer and login text. Logo & favicon are uploaded to Cloudinary and applied everywhere."
    >
      <form onSubmit={saveText} className="space-y-5">
        {!canManage && <ReadOnlyNotice />}
        <fieldset disabled={!canManage} className="min-w-0 space-y-5">
        <Field
          label="Brand name"
          hint="Appears in the sidebar, the browser tab and the login screen."
        >
          <input
            type="text"
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
            placeholder="Senthra"
            className={inputCls}
          />
        </Field>

        <Field
          label="Brand color"
          hint="The accent colour used in your emails — the header bar and links."
        >
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              aria-label="Brand color"
              className="h-10 w-14 shrink-0 cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1"
            />
            <input
              type="text"
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              placeholder={DEFAULT_BRAND_COLOR}
              className={`${inputCls} max-w-[160px] font-mono`}
            />
            {brandColor.toLowerCase() !== DEFAULT_BRAND_COLOR && (
              <button
                type="button"
                onClick={() => setBrandColor(DEFAULT_BRAND_COLOR)}
                disabled={saving}
                className="shrink-0 text-xs font-bold text-[var(--muted)] underline-offset-2 transition-colors hover:text-[var(--accent)] hover:underline disabled:opacity-60"
              >
                Reset to default
              </button>
            )}
          </div>
        </Field>

        <Field
          label="Employee ID prefix"
          hint="The code on new staff IDs. 2–5 letters. Changing it only affects staff created from now on — existing IDs never change."
        >
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              value={employeeIdPrefix}
              onChange={(e) =>
                setEmployeeIdPrefix(
                  e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5),
                )
              }
              placeholder="SNT"
              maxLength={5}
              spellCheck={false}
              className={`${inputCls} max-w-[140px] font-mono uppercase tracking-widest`}
            />
            <span className="text-xs text-[var(--faint)]">
              Next ID looks like{" "}
              <span className="font-mono font-bold text-[var(--muted)]">
                {(employeeIdPrefix || "SNT")}-0007
              </span>
            </span>
          </div>
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <ImageUploader
            title="Logo"
            hint="PNG/SVG with transparency. Recommended 512×512px (or wider for a wordmark), max 2 MB. Shown in the sidebar & login."
            url={logoUrl}
            uploading={uploading === "logo"}
            onPick={(f) => handleUpload("logo", f)}
            onRemove={() => handleRemove("logo")}
          />
          <ImageUploader
            title="Favicon"
            hint="Square PNG/ICO — recommended 512×512px (min 32×32), max 2 MB. The browser-tab icon."
            url={faviconUrl}
            uploading={uploading === "favicon"}
            onPick={(f) => handleUpload("favicon", f)}
            onRemove={() => handleRemove("favicon")}
          />
        </div>

        <Field
          label="Footer text"
          hint="Shown at the bottom of every page. Leave blank to hide it."
        >
          <input
            type="text"
            value={footerText}
            onChange={(e) => setFooterText(e.target.value)}
            placeholder="© 2026 Senthra. All rights reserved."
            className={inputCls}
          />
        </Field>

        <Field
          label="Login headline"
          hint="The large heading visitors see on the login screen."
        >
          <input
            type="text"
            value={loginHeadline}
            onChange={(e) => setLoginHeadline(e.target.value)}
            placeholder="Effortlessly manage your business and operations."
            className={inputCls}
          />
        </Field>

        <Field
          label="Login subtext"
          hint="The smaller supporting line under the login headline."
        >
          <textarea
            value={loginSubtext}
            onChange={(e) => setLoginSubtext(e.target.value)}
            rows={2}
            placeholder="Sign in to access your admin dashboard and run everything from one place."
            className={inputCls}
          />
        </Field>

        <Notice msg={msg} />

        <SaveBar isDirty={isDirty} saving={saving} label="Save branding" />
        </fieldset>
      </form>
    </SettingsCard>
  );
}
