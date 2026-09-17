"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, ChevronDown, Loader2, Plus, Settings2 } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import * as jobTitleService from "@/services/jobTitle.service";
import type { JobTitle } from "@/types/jobTitle";
import { AnchoredPanel } from "@/components/ui/AnchoredPanel";
import { inputCls } from "@/components/ui/styles";
import { useNavigationGuard } from "@/providers/NavigationGuardProvider";

// A creatable combobox for the user form's Job title field: pick an existing title
// from the managed list, or type a new name and create it inline. The committed value
// is the title NAME (a string), matching how User.jobTitle is stored — so existing
// free-text values still display fine.
export function JobTitleCombobox({
  value,
  onChange,
  disabled,
  invalid,
  required,
  describedBy,
}: {
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  describedBy?: string;
}) {
  const { can } = useAuth();
  const canCreate = can("users.create") || can("users.edit");
  // Rename/delete are deliberate, global actions, so they live in the Job titles tab —
  // the picker just links there for anyone who can manage the list.
  const canManage = can("users.edit") || can("users.delete");
  const router = useRouter();
  const guard = useNavigationGuard();
  const openManage = () => {
    setOpen(false);
    guard.attemptLeave(() => router.push("/dashboard/users?tab=jobTitles"));
  };

  const [jobTitles, setJobTitles] = React.useState<JobTitle[]>(
    () => jobTitleService.getCachedJobTitles() ?? [],
  );
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  // The panel hangs off this: `AnchoredPanel` places it against the trigger, follows it while it is
  // visible, and owns the click-outside that used to be a wrapper-containment check here.
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const listboxId = React.useId();

  React.useEffect(() => {
    let alive = true;
    jobTitleService.listJobTitles().then(
      (rows) => alive && setJobTitles(rows),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  const q = query.trim();
  const filtered = q
    ? jobTitles.filter((d) => d.name.toLowerCase().includes(q.toLowerCase()))
    : jobTitles;
  const exact = jobTitles.find((d) => d.name.toLowerCase() === q.toLowerCase());
  const showCreate = canCreate && q.length > 0 && !exact;

  const commit = (name: string) => {
    onChange(name);
    setOpen(false);
    setQuery("");
  };

  const create = async () => {
    if (!q || creating) return;
    setCreating(true);
    try {
      const jt = await jobTitleService.createJobTitle(q);
      setJobTitles((prev) =>
        prev.some((d) => d.id === jt.id)
          ? prev
          : [...prev, jt].sort((a, b) => a.name.localeCompare(b.name)),
      );
      commit(jt.name);
    } catch {
      // Leave the dropdown open so the user can retry or pick an existing one;
      // the backend's uniqueness/permission errors are the authoritative guard.
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <button
        ref={btnRef}
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
        <span className={`truncate ${value ? "text-[var(--ink)]" : "text-[var(--faint)]"}`}>
          {value || "No job title"}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--faint)]" />
      </button>

      <AnchoredPanel
        id={listboxId}
        anchorRef={btnRef}
        open={open && !disabled}
        onDismiss={() => {
          setOpen(false);
          setQuery("");
        }}
      >
        <div className="shrink-0 border-b border-[var(--border-2)] p-2">
          {/* Focus is AnchoredPanel's — an `autoFocus` here cannot work: the panel is invisible until
              it has been placed, and the browser declines focus on a hidden element. */}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (exact) commit(exact.name);
                else if (showCreate) void create();
              } else if (e.key === "Escape") {
                setOpen(false);
                setQuery("");
              }
            }}
            placeholder="Search or type to create…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {/* Clear / unset */}
          <button
            type="button"
            onClick={() => commit("")}
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-[var(--muted)] hover:bg-[var(--surface-2)]"
          >
            <span className="truncate italic">No job title</span>
            {!value && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />}
          </button>

          {filtered.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => commit(d.name)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-[var(--ink)] hover:bg-[var(--surface-2)]"
            >
              <span className="truncate">{d.name}</span>
              {value === d.name && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />}
            </button>
          ))}

          {showCreate && (
            <button
              type="button"
              onClick={() => void create()}
              disabled={creating}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent-10)] disabled:opacity-60"
            >
              {creating ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5 shrink-0" />
              )}
              Create &ldquo;{q}&rdquo;
            </button>
          )}

          {filtered.length === 0 && !showCreate && (
            <p className="px-3 py-3 text-center text-xs text-[var(--muted)]">
              {jobTitles.length === 0
                ? canCreate
                  ? "No job titles yet — type a name to create one."
                  : "No job titles yet."
                : "No match."}
            </p>
          )}
        </div>

        {canManage && (
          <div className="shrink-0 border-t border-[var(--border-2)] p-1">
            <button
              type="button"
              onClick={openManage}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
            >
              <Settings2 className="h-3.5 w-3.5 shrink-0" />
              Manage job titles
              <ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0" />
            </button>
          </div>
        )}
      </AnchoredPanel>
    </div>
  );
}
