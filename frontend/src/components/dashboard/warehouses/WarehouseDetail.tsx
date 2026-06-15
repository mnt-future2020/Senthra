"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Activity, Boxes, Loader2, MapPin, Pencil, Power, ScrollText } from "lucide-react";

import * as warehouseService from "@/services/warehouse.service";
import * as auditService from "@/services/audit.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { actionLabel, actionTone, relativeTime, TONE_CLASSES } from "@/components/dashboard/audit/auditDisplay";
import type { AuditEntry } from "@/types/audit";
import type { Warehouse } from "@/types/warehouse";
import type { UserStatus } from "@/types/user";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

type Tab = "overview" | "inventory" | "transactions" | "audit";
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "inventory", label: "Inventory" },
  { key: "transactions", label: "Transactions" },
  { key: "audit", label: "Audit trail" },
];

export function WarehouseDetail({ initial }: { initial: Warehouse }) {
  const router = useRouter();
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const [w, setW] = React.useState<Warehouse>(initial);
  const [tab, setTab] = React.useState<Tab>("overview");
  const [busy, setBusy] = React.useState(false);
  const canEdit = can("warehouse.edit");

  const toggleStatus = async () => {
    const next = w.status === "active" ? "inactive" : "active";
    setBusy(true);
    try {
      const updated = await warehouseService.updateWarehouse(w.id, { status: next });
      setW(updated);
      pushToast(next === "inactive" ? "Warehouse deactivated." : "Warehouse activated.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not update the warehouse.", "alert");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header card */}
      <div
        className="flex flex-col gap-4 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs sm:flex-row sm:items-start sm:justify-between"
        style={{ borderRadius: "var(--radius)" }}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">{w.name}</h1>
            <StatusBadge status={w.status as UserStatus} />
            {w.isDefault && (
              <span className="rounded-full bg-[var(--accent-10)] px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--accent)]">
                Default
              </span>
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <span className="font-mono">{w.code}</span>
            <span aria-hidden>·</span>
            <span>{w.type?.name ?? "—"}</span>
          </p>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={toggleStatus}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
              {w.status === "active" ? "Deactivate" : "Activate"}
            </button>
            <button
              type="button"
              onClick={() => router.push(`/dashboard/warehouses/${w.code}/edit`)}
              className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`shrink-0 border-b-2 px-3.5 py-2.5 text-xs font-bold transition-colors ${
              tab === t.key
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--ink)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview w={w} />}
      {tab === "inventory" && (
        <Placeholder
          icon={Boxes}
          title="Inventory"
          body="Stock currently held at this warehouse will appear here once the inventory module is connected."
        />
      )}
      {tab === "transactions" && (
        <Placeholder
          icon={Activity}
          title="Transactions"
          body="Goods in, goods out, transfers and adjustments for this warehouse will be listed here once inventory movements are live."
        />
      )}
      {tab === "audit" && <AuditTrail warehouseId={w.id} />}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <h2 className="mb-4 text-sm font-extrabold text-[var(--ink)]">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</p>
      <div className="mt-0.5 text-sm text-[var(--ink)]">{children || "—"}</div>
    </div>
  );
}

function Overview({ w }: { w: Warehouse }) {
  const addressLines = [w.addressLine1, w.addressLine2, w.city, w.county, w.postcode, w.country]
    .map((l) => l?.trim())
    .filter(Boolean);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Location">
        <div className="space-y-3">
          <Field label="Address">
            {addressLines.length ? (
              <div className="space-y-0.5">
                {addressLines.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            ) : (
              ""
            )}
          </Field>
          <Field label="Coordinates">
            {w.latitude != null && w.longitude != null ? (
              <span className="inline-flex items-center gap-1.5 text-[var(--muted)]">
                <MapPin className="h-3.5 w-3.5 text-[var(--accent)]" />
                {w.latitude.toFixed(5)}, {w.longitude.toFixed(5)}
              </span>
            ) : (
              <span className="text-[var(--faint)]">Not resolved from postcode</span>
            )}
          </Field>
        </div>
      </Card>

      <Card title="Contact">
        <div className="space-y-3">
          <Field label="Contact person">{w.contactPerson}</Field>
          <Field label="Email">
            {w.contactEmail ? (
              <a className="text-[var(--accent)] hover:underline" href={`mailto:${w.contactEmail}`}>
                {w.contactEmail}
              </a>
            ) : (
              ""
            )}
          </Field>
          <Field label="Phone">
            {w.contactPhone ? (
              <a className="text-[var(--accent)] hover:underline" href={`tel:${w.contactPhone}`}>
                {w.contactPhone}
              </a>
            ) : (
              ""
            )}
          </Field>
        </div>
      </Card>

      <Card title="Management">
        <div className="space-y-3">
          <Field label="Warehouse manager">
            {w.manager ? (
              <div>
                <div className="font-semibold">
                  {w.manager.name}
                  {w.manager.jobTitle && (
                    <span className="ml-1.5 text-xs font-normal text-[var(--muted)]">
                      · {w.manager.jobTitle}
                    </span>
                  )}
                </div>
                <a className="text-xs text-[var(--accent)] hover:underline" href={`mailto:${w.manager.email}`}>
                  {w.manager.email}
                </a>
              </div>
            ) : (
              <span className="text-[var(--faint)]">No manager assigned</span>
            )}
          </Field>
          {w.description && <Field label="Description">{w.description}</Field>}
        </div>
      </Card>

      <Card title="Operations">
        <div className="space-y-3">
          <Field label="Operating hours">{w.operatingHours}</Field>
          <Field label="Timezone">{w.timezone}</Field>
          <Field label="Notes">{w.notes}</Field>
        </div>
      </Card>

      <Card title="Record">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">{w.type?.name ?? "—"}</Field>
          <Field label="Default">{w.isDefault ? "Yes" : "No"}</Field>
          <Field label="Created">{fmtDate(w.createdAt)}</Field>
          <Field label="Updated">{fmtDate(w.updatedAt)}</Field>
          <Field label="Created by">{w.createdBy}</Field>
          <Field label="Updated by">{w.updatedBy}</Field>
        </div>
      </Card>
    </div>
  );
}

function Placeholder({ icon: Icon, title, body }: { icon: React.ElementType; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-16 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent-10)] text-[var(--accent)]">
        <Icon className="h-5 w-5" />
      </span>
      <p className="text-sm font-bold text-[var(--ink)]">{title}</p>
      <p className="max-w-md text-xs text-[var(--muted)]">{body}</p>
      <span className="mt-1 rounded-full bg-[var(--surface-2)] px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
        Coming soon
      </span>
    </div>
  );
}

// Warehouse-specific audit history. The API filters by targetType; we narrow to this
// warehouse's id client-side (a single warehouse's history is small).
function AuditTrail({ warehouseId }: { warehouseId: string }) {
  const [entries, setEntries] = React.useState<AuditEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    auditService
      .listAuditLogs({ targetType: "warehouse", pageSize: 100 })
      .then((res) => {
        if (active) setEntries(res.entries.filter((e) => e.targetId === warehouseId));
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load the audit trail.");
      });
    return () => {
      active = false;
    };
  }, [warehouseId]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
  if (entries === null) {
    return (
      <div className="flex items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-16">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--muted)]" />
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
        <ScrollText className="h-7 w-7 text-[var(--faint)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">No activity yet</p>
        <p className="text-xs text-[var(--muted)]">Changes to this warehouse will be recorded here.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <ul className="divide-y divide-[var(--border)]">
        {entries.map((e) => (
          <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-3">
              <span
                className={`inline-block shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${TONE_CLASSES[actionTone(e.action)]}`}
              >
                {actionLabel(e.action)}
              </span>
              <span className="text-xs text-[var(--muted)]">{e.actorEmail ?? "system"}</span>
            </div>
            <span className="shrink-0 text-[11px] text-[var(--faint)]" title={new Date(e.createdAt).toLocaleString("en-GB")}>
              {relativeTime(e.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
