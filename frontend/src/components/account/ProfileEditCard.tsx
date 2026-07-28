"use client";

import * as React from "react";
import { AlertTriangle, Loader2, RefreshCw, Upload, UserRound } from "lucide-react";

import * as userService from "@/services/user.service";
import { PostcodeField } from "@/components/ui/PostcodeField";
import { MAX_IMAGE_BYTES, readFileAsDataUrl } from "@/lib/image";
import { optimizeCloudinaryUrl } from "@/lib/utils";
import type { User } from "@/types/user";

// Self-service profile edit for any staff user (used by the Engineer Portal's Settings + every My
// Account). Edits ONLY phone, avatar and address — name/role/email are admin-managed (the backend
// whitelist enforces this regardless of what's posted).
type Form = { phone: string; addressLine1: string; addressLine2: string; city: string; postcode: string };
const EMPTY: Form = { phone: "", addressLine1: "", addressLine2: "", city: "", postcode: "" };

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]";

export function ProfileEditCard() {
  const [form, setForm] = React.useState<Form>(EMPTY);
  const [currentAvatar, setCurrentAvatar] = React.useState<string | null>(null);
  const [newImage, setNewImage] = React.useState<string | null>(null);
  const [removeImage, setRemoveImage] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0); // bumped by Retry to re-run the load effect
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ type: "success" | "error"; text: string } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const hydrate = (u: User) => {
    setForm({
      phone: u.phone ?? "",
      addressLine1: u.addressLine1 ?? "",
      addressLine2: u.addressLine2 ?? "",
      city: u.city ?? "",
      postcode: u.postcode ?? "",
    });
    setCurrentAvatar(u.profileImageUrl);
    setNewImage(null);
    setRemoveImage(false);
  };

  // Loads on mount and whenever Retry bumps reloadKey. The loading/error reset lives in the retry
  // handler (an event), so the effect body holds no synchronous setState. Initial render already
  // starts in the loading state (useState(true)).
  React.useEffect(() => {
    let active = true;
    userService
      .getMyProfile()
      .then((u) => active && hydrate(u))
      .catch((e) => active && setLoadError(e instanceof Error ? e.message : "Could not load your profile."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const retryLoad = () => {
    setLoading(true);
    setLoadError(null);
    setReloadKey((k) => k + 1);
  };

  const pickImage = async (file: File) => {
    setMsg(null);
    if (!file.type.startsWith("image/")) {
      setMsg({ type: "error", text: "Use a PNG or JPG image." });
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setMsg({ type: "error", text: "Image must be under 2 MB." });
      return;
    }
    setNewImage(await readFileAsDataUrl(file));
    setRemoveImage(false);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      const u = await userService.updateMyProfile({
        phone: form.phone,
        addressLine1: form.addressLine1,
        addressLine2: form.addressLine2,
        city: form.city,
        postcode: form.postcode,
        ...(newImage ? { profileImage: newImage } : {}),
        ...(removeImage ? { removeProfileImage: true } : {}),
      });
      hydrate(u);
      setMsg({ type: "success", text: "Profile updated." });
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  };

  const set = (k: keyof Form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  // PostcodeField drives City through a React state setter (so it can fill it and later undo
  // its own fill); this adapts one key of the single `form` object into that shape.
  const setField = (k: keyof Form): React.Dispatch<React.SetStateAction<string>> =>
    (v) => setForm((f) => ({ ...f, [k]: typeof v === "function" ? v(f[k]) : v }));
  const previewUrl = removeImage ? null : newImage ?? (currentAvatar ? optimizeCloudinaryUrl(currentAvatar) : null);

  if (loading) return <ProfileEditSkeleton />;
  if (loadError) return <ProfileEditError message={loadError} onRetry={retryLoad} />;

  return (
    <section className="border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xs" style={{ borderRadius: "var(--radius)" }}>
      <div className="flex items-center gap-2">
        <UserRound className="h-4 w-4 text-[var(--accent)]" />
        <h2 className="text-sm font-extrabold text-[var(--ink)]">Edit profile</h2>
      </div>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Update your photo, phone and address. Your name, role and email are managed by an administrator.
      </p>

      <form onSubmit={save} className="mt-4 space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl bg-[var(--surface-2)] ring-1 ring-[var(--border)]">
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="Your avatar" className="h-full w-full object-cover" />
            ) : (
              <UserRound className="h-6 w-6 text-[var(--faint)]" />
            )}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)]"
            >
              <Upload className="h-3.5 w-3.5" /> {previewUrl ? "Replace" : "Upload"}
            </button>
            {previewUrl && (
              <button
                type="button"
                onClick={() => {
                  setNewImage(null);
                  setRemoveImage(true);
                }}
                className="rounded-xl px-3 py-2 text-xs font-bold text-[var(--muted)] transition-colors hover:text-[var(--neg)]"
              >
                Remove
              </button>
            )}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs font-bold text-[var(--ink)]">Phone</span>
            <input className={inputCls} value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+44 …" />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-bold text-[var(--ink)]">City</span>
            <input className={inputCls} value={form.city} onChange={(e) => set("city", e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-bold text-[var(--ink)]">Address line 1</span>
            <input className={inputCls} value={form.addressLine1} onChange={(e) => set("addressLine1", e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-bold text-[var(--ink)]">Address line 2</span>
            <input className={inputCls} value={form.addressLine2} onChange={(e) => set("addressLine2", e.target.value)} />
          </label>
          {/* Shared field: same validation, canonical "LS1 4DY" formatting and postcode lookup
              as every other address form, instead of a bare text input. */}
          <PostcodeField
            value={form.postcode}
            onChange={(v) => set("postcode", v)}
            setCity={setField("city")}
            required={false}
          />
        </div>

        {msg && (
          <p className={`text-xs font-semibold ${msg.type === "success" ? "text-[var(--pos)]" : "text-[var(--neg)]"}`}>{msg.text}</p>
        )}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
          </button>
        </div>
      </form>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pickImage(f);
          e.target.value = "";
        }}
      />
    </section>
  );
}

// Card chrome shared by the loading + error states so the panel doesn't pop/shift in.
function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xs" style={{ borderRadius: "var(--radius)" }}>
      <div className="flex items-center gap-2">
        <UserRound className="h-4 w-4 text-[var(--accent)]" />
        <h2 className="text-sm font-extrabold text-[var(--ink)]">Edit profile</h2>
      </div>
      {children}
    </section>
  );
}

// Skeleton placeholder while the profile loads — mirrors the avatar + field grid layout.
function ProfileEditSkeleton() {
  return (
    <CardShell>
      <div className="mt-4 animate-pulse space-y-4">
        <div className="flex items-center gap-3">
          <span className="h-16 w-16 rounded-2xl bg-[var(--surface-2)]" />
          <span className="h-8 w-24 rounded-xl bg-[var(--surface-2)]" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <span className="block h-3 w-20 rounded bg-[var(--surface-2)]" />
              <span className="block h-9 w-full rounded-lg bg-[var(--surface-2)]" />
            </div>
          ))}
        </div>
      </div>
    </CardShell>
  );
}

// Error state with an explicit Retry — never fails silently.
function ProfileEditError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <CardShell>
      <div className="mt-4 flex flex-col items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-[var(--neg)]">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{message}</span>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-colors hover:bg-[var(--surface-2)]"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </button>
      </div>
    </CardShell>
  );
}
