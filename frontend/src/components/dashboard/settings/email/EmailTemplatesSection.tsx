"use client";

import * as React from "react";
import { Eye, Mail, Pencil } from "lucide-react";

import * as templateService from "@/services/emailTemplate.service";
import { useAuth } from "@/hooks/useAuth";
import type { EmailTemplate } from "@/types/emailTemplate";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmailTemplateEditor } from "./EmailTemplateEditor";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { Toggle } from "@/components/dashboard/settings/ui/Toggle";

// Human-friendly category headings.
const CATEGORY_LABELS: Record<string, string> = {
  account: "Account",
  security: "Security",
  notification: "Notifications",
  custom: "Custom",
};

// Section order in the list — by business priority, not alphabetical. Any category not
// listed here falls to the end (keeps custom/unknown categories stable at the bottom).
const CATEGORY_ORDER = ["account", "notification", "security", "custom"];

// Skeleton mirrors the grouped template list.
function TemplatesSkeleton() {
  return (
    <div className="space-y-5">
      {Array.from({ length: 2 }).map((_, g) => (
        <div key={g}>
          <Skeleton className="mb-2 h-2.5 w-20" />
          <div className="divide-y divide-[var(--border-2)] overflow-hidden rounded-xl border border-[var(--border)]">
            {Array.from({ length: g + 1 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-3.5">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-2.5 w-56 max-w-full" />
                </div>
                <Skeleton className="h-6 w-11 rounded-full" />
                <Skeleton className="h-7 w-16 rounded-lg" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmailTemplatesSection() {
  const { can } = useAuth();
  const canManage = can("email_templates.manage");
  // Seed from the cache so a revisit renders instantly instead of the skeleton.
  const [templates, setTemplates] = React.useState<EmailTemplate[]>(
    () => templateService.getCachedTemplates() ?? [],
  );
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setTemplates(await templateService.listTemplates());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load templates.");
    }
  }, []);

  React.useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  const toggleEnabled = async (t: EmailTemplate) => {
    // Optimistic flip; revert by reloading if the request fails.
    setTemplates((prev) =>
      prev.map((x) => (x.id === t.id ? { ...x, enabled: !x.enabled } : x)),
    );
    try {
      await templateService.setEnabled(t.id, !t.enabled);
    } catch {
      load();
    }
  };

  // Group by category, then order the sections by business priority (see CATEGORY_ORDER).
  // Templates within a group keep the backend's name-sorted order. Memoised so the grouping
  // isn't recomputed on unrelated re-renders (e.g. an optimistic toggle). Must run before the
  // editor early-return below to keep hook order stable across renders.
  const orderedGroups = React.useMemo(() => {
    const byCat = templates.reduce<Record<string, EmailTemplate[]>>((acc, t) => {
      (acc[t.category] ??= []).push(t);
      return acc;
    }, {});
    const rank = (c: string) => {
      const i = CATEGORY_ORDER.indexOf(c);
      return i === -1 ? CATEGORY_ORDER.length : i;
    };
    return Object.entries(byCat).sort(([a], [b]) => rank(a) - rank(b));
  }, [templates]);

  const editing = templates.find((t) => t.id === editingId) ?? null;
  if (editing) {
    return (
      <EmailTemplateEditor
        template={editing}
        onBack={() => setEditingId(null)}
        onChanged={load}
      />
    );
  }

  return (
    <SettingsCard
      icon={Mail}
      title="Email Templates"
      desc="Edit the emails the app sends. Toggle one off to stop it (security emails always send)."
    >
      {loading && templates.length === 0 ? (
        <TemplatesSkeleton />
      ) : error ? (
        <div className="py-10 text-center text-sm text-[var(--neg)]">{error}</div>
      ) : templates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] py-10 text-center">
          <p className="text-sm font-bold text-[var(--ink)]">No email templates yet</p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            The system&apos;s default templates load automatically — try refreshing in a moment.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {orderedGroups.map(([category, items]) => (
            <div key={category}>
              <h4 className="mb-2 text-[10px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
                {CATEGORY_LABELS[category] ?? category}
              </h4>
              <div className="divide-y divide-[var(--border-2)] overflow-hidden rounded-xl border border-[var(--border)]">
                {items.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 p-3.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-[var(--ink)]">{t.name}</p>
                      <p className="truncate text-xs text-[var(--muted)]">{t.subject}</p>
                    </div>
                    <Toggle
                      checked={t.enabled}
                      onChange={() => toggleEnabled(t)}
                      disabled={!canManage}
                      aria-label={`Enable ${t.name}`}
                    />
                    <button
                      onClick={() => setEditingId(t.id)}
                      className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)]"
                    >
                      {canManage ? (
                        <Pencil className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                      {canManage ? "Edit" : "View"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </SettingsCard>
  );
}
