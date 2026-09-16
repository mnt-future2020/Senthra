"use client";

import * as React from "react";
import { Printer } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import * as brandingService from "@/services/branding.service";
import * as settingsService from "@/services/settings.service";
import type { Settings } from "@/types/settings";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { ReadOnlyNotice } from "@/components/dashboard/settings/ui/ReadOnlyNotice";
import { SaveBar } from "@/components/dashboard/settings/ui/SaveBar";
import { ImageUploader } from "@/components/dashboard/settings/ui/ImageUploader";
import { Notice } from "@/components/ui/Notice";
import { Field } from "@/components/ui/Field";
import { inputCls } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";
import { useReportDirty } from "@/providers/NavigationGuardProvider";
import { MAX_IMAGE_BYTES, readFileAsDataUrl, shrinkImage } from "@/lib/image";
import { accentColorError, poDocBrandingView, toColorInputValue } from "./poSettings";

// The PO document's OWN logo and accent colour. Both optional: unset, the PO PDF uses the app branding
// exactly as it always has. Neither value touches the app shell or emails — only the PO document
// (downloads, the supplier email attachment and the archived issued copy).

// Raster types only: the PO logo is drawn by the PDF engine, which embeds PNG/JPEG (the server converts
// an uploaded GIF/WEBP through Cloudinary). SVG/ICO — accepted for the app logo/favicon — are left out.
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function PoDocumentBrandingCard() {
  const { can } = useAuth();
  const canManage = can("settings.manage");
  const { pushToast } = useDashboard();

  const [settings, setSettings] = React.useState<Settings | null>(null);
  // The PO accent being edited ("" = use the app colour) and its last-saved value.
  const [color, setColor] = React.useState("");
  const [savedColor, setSavedColor] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  // ERRORS ONLY — success is a toast, as on the other Settings cards.
  const [msg, setMsg] = React.useState<Msg>(null);

  const isDirty = color.trim() !== savedColor;
  useReportDirty("po-document-branding", isDirty);

  React.useEffect(() => {
    (async () => {
      try {
        const s = await settingsService.getSettings();
        setSettings(s);
        setColor(s.poDocAccentColor);
        setSavedColor(s.poDocAccentColor);
      } catch {
        // ignore — leave the card on its empty state
      }
    })();
  }, []);

  const handleUpload = async (file: File) => {
    setMsg(null);
    if (file.type && !ALLOWED_IMAGE_TYPES.has(file.type)) {
      setMsg({ type: "error", text: "Unsupported file. Use a PNG, JPG, GIF or WEBP image." });
      return;
    }
    const image = await shrinkImage(file);
    if (image.size > MAX_IMAGE_BYTES) {
      setMsg({ type: "error", text: "Image must be under 2 MB." });
      return;
    }
    setUploading(true);
    try {
      const { settings: next } = await brandingService.uploadBrandingImage("po_logo", await readFileAsDataUrl(image));
      setSettings(next);
      pushToast("PO logo uploaded.");
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Upload failed." });
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = async () => {
    setMsg(null);
    setUploading(true);
    try {
      setSettings(await settingsService.updateSettings({ poDocLogoUrl: "" }));
      pushToast("PO logo removed — PO documents use the app logo.");
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Remove failed." });
    } finally {
      setUploading(false);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const error = accentColorError(color);
    if (error) {
      setMsg({ type: "error", text: error });
      return;
    }
    setSaving(true);
    try {
      const next = await settingsService.updateSettings({ poDocAccentColor: color.trim() });
      setSettings(next);
      setColor(next.poDocAccentColor);
      setSavedColor(next.poDocAccentColor);
      pushToast(next.poDocAccentColor ? "PO accent colour saved." : "PO documents now use the app colour.");
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  };

  const view = settings ? poDocBrandingView(settings) : null;

  return (
    <SettingsCard
      icon={Printer}
      title="PO PDF branding"
      desc="The logo and accent colour printed on purchase order documents — downloads, supplier emails and the archived issued copy. Leave either unset to use the app branding. The app itself and your emails are not affected."
    >
      <form onSubmit={save} className="space-y-5">
        {!canManage && <ReadOnlyNotice />}
        <fieldset disabled={!canManage} className="min-w-0 space-y-5">
          <div>
            <ImageUploader
              title="PO logo"
              hint="PNG or JPG, up to 2 MB. Printed on the coloured header band — a light logo reads best on a dark accent."
              url={settings?.poDocLogoUrl ?? ""}
              uploading={uploading}
              onPick={handleUpload}
              onRemove={handleRemove}
            />
            {view?.logoIsFallback && (
              <p className="mt-2 text-[11px] text-[var(--muted)]">
                {view.logoUrl
                  ? "Not set — PO documents use the app logo."
                  : "Not set — there is no app logo either, so PO documents print the company name."}
              </p>
            )}
          </div>

          <Field
            label="PO accent colour"
            hint="Header band, section headings and the items table header on the PO document. A 3- or 6-digit hex colour."
          >
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="color"
                value={toColorInputValue(color || view?.color || "")}
                onChange={(e) => setColor(e.target.value)}
                aria-label="PO accent colour picker"
                className="h-10 w-14 shrink-0 cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1"
              />
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder={view?.color ?? "#7b6ef0"}
                aria-label="PO accent colour"
                spellCheck={false}
                className={`${inputCls} max-w-[160px] font-mono`}
              />
              {color && (
                <button
                  type="button"
                  onClick={() => setColor("")}
                  disabled={saving}
                  className="shrink-0 text-xs font-bold text-[var(--muted)] underline-offset-2 transition-colors hover:text-[var(--accent)] hover:underline disabled:opacity-60"
                >
                  Use app colour
                </button>
              )}
            </div>
            {!color.trim() && settings && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
                Not set — PO documents use the app brand colour
                <span
                  aria-hidden="true"
                  className="inline-block h-3 w-3 rounded-sm border border-[var(--border)]"
                  style={{ backgroundColor: view?.color }}
                />
                <span className="font-mono">{view?.color}</span>
              </p>
            )}
          </Field>

          <Notice msg={msg} />
          <SaveBar
            isDirty={isDirty}
            saving={saving}
            label="Save PO colour"
            onDiscard={() => {
              setColor(savedColor);
              setMsg(null);
            }}
          />
        </fieldset>
      </form>
    </SettingsCard>
  );
}
