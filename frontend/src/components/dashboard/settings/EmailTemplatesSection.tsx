"use client";

import * as React from "react";
import { Eye, Mail, Pencil } from "lucide-react";

import * as templateService from "@/services/emailTemplate.service";
import { useAuth } from "@/hooks/useAuth";
import type { EmailTemplate } from "@/types/emailTemplate";
import { Skeleton } from "@/components/ui/skeleton";
import { EmailTemplateEditor } from "./EmailTemplateEditor";
import { SettingsCard } from "./ui/SettingsCard";
import { Toggle } from "./ui/Toggle";

// Human-friendly category headings.
const CATEGORY_LABELS: Record<string, string> = {
  account: "Account",
  security: "Security",
  notification: "Notifications",
  custom: "Custom",
};

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

  // Group templates by category, preserving a sensible order.
  const groups = templates.reduce<Record<string, EmailTemplate[]>>((acc, t) => {
    (acc[t.category] ??= []).push(t);
    return acc;
  }, {});

  return (
    <SettingsCard
      icon={Mail}
      title="Email Templates"
      desc="Customise every email the app sends — content, subject and styling. Variables like {{firstName}} are filled in automatically. Disable a template to stop that email (account & security emails always send)."
    >
      {loading && templates.length === 0 ? (
        <TemplatesSkeleton />
      ) : error ? (
        <div className="py-10 text-center text-sm text-[var(--neg)]">{error}</div>
      ) : (
        <div className="space-y-5">
          {Object.entries(groups).map(([category, items]) => (
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
