"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, ChevronDown, Loader2, Plus, Settings2 } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import * as departmentService from "@/services/department.service";
import type { Department } from "@/types/department";
import { inputCls } from "@/components/dashboard/settings/ui/styles";
import { useNavigationGuard } from "@/providers/NavigationGuardProvider";

// A creatable combobox for the user form's Department field: pick an existing
// department from the managed list, or type a new name and create it inline (the
// "mahal" pattern). The committed value is the department NAME (a string), matching
// how User.department is stored — so existing free-text values still display fine.
export function DepartmentCombobox({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
}) {
  const { can } = useAuth();
  // Adding a department is part of creating/editing staff, so either user permission
  // unlocks inline create (the backend gates it the same way).
  const canCreate = can("users.create") || can("users.edit");
  // Rename/delete are deliberate, global actions, so they live in the Departments
  // tab — the picker just links there for anyone who can manage the list.
  const canManage = can("users.edit") || can("users.delete");
  const router = useRouter();
  const guard = useNavigationGuard();
  const openManage = () => {
    setOpen(false);
    // Respect the form's unsaved-changes guard before leaving for the manage tab.
    guard.attemptLeave(() => router.push("/dashboard/users?tab=departments"));
  };

  const [departments, setDepartments] = React.useState<Department[]>(
    () => departmentService.getCachedDepartments() ?? [],
  );
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  // Cache-first, then revalidate so the list is fresh without a loading flash.
  React.useEffect(() => {
    let alive = true;
    departmentService.listDepartments().then(
      (rows) => alive && setDepartments(rows),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  // Close on outside click.
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
  const filtered = q
    ? departments.filter((d) => d.name.toLowerCase().includes(q.toLowerCase()))
    : departments;
  const exact = departments.find((d) => d.name.toLowerCase() === q.toLowerCase());
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
      const dept = await departmentService.createDepartment(q);
      setDepartments((prev) =>
        prev.some((d) => d.id === dept.id)
          ? prev
          : [...prev, dept].sort((a, b) => a.name.localeCompare(b.name)),
      );
      commit(dept.name);
    } catch {
      // Leave the dropdown open so the user can retry or pick an existing one;
      // the backend's uniqueness/permission errors are the authoritative guard.
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`${inputCls} flex items-center justify-between gap-2 text-left`}
      >
        <span className={`truncate ${value ? "text-[var(--ink)]" : "text-[var(--faint)]"}`}>
          {value || "No department"}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--faint)]" />
      </button>

      {open && !disabled && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
          <div className="border-b border-[var(--border-2)] p-2">
            <input
              autoFocus
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
          <div className="max-h-56 overflow-auto py-1">
            {/* Clear / unset */}
            <button
              type="button"
              onClick={() => commit("")}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-[var(--muted)] hover:bg-[var(--surface-2)]"
            >
              <span className="truncate italic">No department</span>
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
                {departments.length === 0
                  ? canCreate
                    ? "No departments yet — type a name to create one."
                    : "No departments yet."
                  : "No match."}
              </p>
            )}
          </div>

          {canManage && (
            <div className="border-t border-[var(--border-2)] p-1">
              <button
                type="button"
                onClick={openManage}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
              >
                <Settings2 className="h-3.5 w-3.5 shrink-0" />
                Manage departments
                <ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
