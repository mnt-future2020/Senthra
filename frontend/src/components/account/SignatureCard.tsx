"use client";

import * as React from "react";
import { Loader2, PenLine, Trash2, Upload } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import * as userService from "@/services/user.service";
import { MAX_IMAGE_BYTES, readFileAsDataUrl } from "@/lib/image";

// Self-service signature for the signed-in staff user. The signature is printed on documents the
// user issues (e.g. the Purchase Order PDF emailed to suppliers). Optional — mirrors the avatar
// upload pattern (data URI → backend → Cloudinary), with its own /users/me/signature endpoints.
export function SignatureCard({ style }: { style?: React.CSSProperties }) {
  const { user } = useAuth();
  const [url, setUrl] = React.useState<string | null>(user?.signatureUrl ?? null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ type: "success" | "error"; text: string } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  if (!user) return null;

  const onFile = async (file: File) => {
    setMsg(null);
    if (!file.type.startsWith("image/")) {
      setMsg({ type: "error", text: "Use a PNG or JPG image." });
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setMsg({ type: "error", text: "Image must be under 2 MB." });
      return;
    }
    setBusy(true);
    try {
      const data = await readFileAsDataUrl(file);
      const updated = await userService.uploadMySignature(data, file.name);
      setUrl(updated.signatureUrl);
      setMsg({ type: "success", text: "Signature saved." });
    } catch (e) {
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Upload failed." });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remove = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const updated = await userService.removeMySignature();
      setUrl(updated.signatureUrl);
      setMsg({ type: "success", text: "Signature removed." });
    } catch (e) {
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Remove failed." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xs"
      style={{ borderRadius: "var(--radius)", ...style }}
    >
      <div className="flex items-center gap-2">
        <PenLine className="h-4 w-4 text-[var(--accent)]" />
        <h2 className="text-sm font-extrabold text-[var(--ink)]">Signature</h2>
      </div>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Printed on documents you issue — like the Purchase Orders you send to suppliers. Optional.
      </p>

      <div className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <div className="flex h-20 w-48 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)]">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt="Your signature" className="max-h-full max-w-full object-contain p-2" />
          ) : (
            <span className="text-[11px] text-[var(--faint)]">No signature</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {url ? "Replace" : "Upload"}
          </button>
          {url && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold text-[var(--muted)] transition-all hover:text-[var(--neg)] disabled:opacity-60"
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </button>
          )}
        </div>
      </div>

      <p className="mt-2 text-[11px] text-[var(--faint)]">PNG or JPG, max 2 MB. A transparent PNG looks best on documents.</p>
      {msg && (
        <p className={`mt-3 text-xs font-semibold ${msg.type === "success" ? "text-[var(--pos)]" : "text-[var(--neg)]"}`}>
          {msg.text}
        </p>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
        }}
      />
    </section>
  );
}
