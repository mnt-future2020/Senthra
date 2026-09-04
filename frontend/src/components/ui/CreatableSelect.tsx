"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, ChevronDown, Loader2, Plus, Settings2 } from "lucide-react";

import { dropdownRadius, dropdownSurfaceCls, inputCls } from "./styles";
import { useNavigationGuard } from "@/providers/NavigationGuardProvider";

export interface CreatableOption {
  id: string;
  name: string;
}

// A select that also lets the user create a new master-data option inline (type,
// category, …) and immediately picks it — no Settings round-trip. Commits the option
// ID (so it drops in where a plain id-valued <select> was). The parent owns the option
// list and supplies `onCreate`, which creates the record AND appends it to that list,
// returning the new option. Mirrors the JobTitleCombobox UX; create + manage are
// permission-gated by the caller.
interface CreatableSelectProps {
  value: string;
  onChange: (id: string) => void;
  options: CreatableOption[];
  // Omit (or pass canCreate=false) to make this a plain picker with no create option.
  onCreate?: (name: string) => Promise<CreatableOption>;
  canCreate?: boolean;
  // "Manage …" link to the Settings master list (rename/delete live there).
  manageHref?: string;
  canManage?: boolean;
  noun?: string; // e.g. "type" / "category" — used in placeholder + labels
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  required?: boolean;
  describedBy?: string;
}

export function CreatableSelect({
  value,
  onChange,
  options,
  onCreate,
  canCreate,
  manageHref,
  canManage,
  noun = "item",
  placeholder,
  invalid,
  disabled,
  required,
  describedBy,
}: CreatableSelectProps) {
  const router = useRouter();
  const guard = useNavigationGuard();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const listboxId = React.useId();

  const selected = options.find((o) => o.id === value) ?? null;
  const ph = placeholder ?? `— Select a ${noun} —`;
  const allowCreate = Boolean(canCreate && onCreate);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const q = query.trim();
  const filtered = q ? options.filter((o) => o.name.toLowerCase().includes(q.toLowerCase())) : options;
  const exact = options.find((o) => o.name.toLowerCase() === q.toLowerCase());
  const showCreate = allowCreate && q.length > 0 && !exact;

  const commit = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  const create = async () => {
    if (!q || creating || !onCreate) return;
    setCreating(true);
    try {
      const rec = await onCreate(q);
      commit(rec.id);
    } catch {
      // Keep the dropdown open so the user can retry or pick an existing one — the
      // backend's uniqueness/permission errors are the authoritative guard.
    } finally {
      setCreating(false);
    }
  };

  const openManage = () => {
    if (!manageHref) return;
    setOpen(false);
    guard.attemptLeave(() => router.push(manageHref));
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        role="combobox"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-required={required}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`${inputCls} flex items-center justify-between gap-2 text-left`}
      >
        <span className={`truncate ${selected ? "text-[var(--ink)]" : "text-[var(--faint)]"}`}>{selected?.name ?? ph}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--faint)]" />
      </button>

      {open && !disabled && (
        <div id={listboxId} className={`absolute z-30 mt-1 w-full overflow-hidden ${dropdownSurfaceCls}`} style={dropdownRadius}>
          <div className="border-b border-[var(--border-2)] p-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (exact) commit(exact.id);
                  else if (showCreate) void create();
                } else if (e.key === "Escape") {
                  setOpen(false);
                  setQuery("");
                }
              }}
              placeholder={allowCreate ? "Search or type to create…" : "Search…"}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div className="max-h-56 overflow-auto py-1">
            {filtered.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => commit(o.id)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-[var(--ink)] hover:bg-[var(--surface-2)]"
              >
                <span className="truncate">{o.name}</span>
                {value === o.id && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />}
              </button>
            ))}

            {showCreate && (
              <button
                type="button"
                onClick={() => void create()}
                disabled={creating}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent-10)] disabled:opacity-60"
              >
                {creating ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Plus className="h-3.5 w-3.5 shrink-0" />}
                Create &ldquo;{q}&rdquo;
              </button>
            )}

            {filtered.length === 0 && !showCreate && (
              <p className="px-3 py-3 text-center text-xs text-[var(--muted)]">No match.</p>
            )}
          </div>

          {canManage && manageHref && (
            <div className="border-t border-[var(--border-2)] p-1">
              <button
                type="button"
                onClick={openManage}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
              >
                <Settings2 className="h-3.5 w-3.5 shrink-0" />
                Manage {noun} list
                <ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
