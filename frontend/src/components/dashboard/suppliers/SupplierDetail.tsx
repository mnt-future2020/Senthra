"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Boxes, ClipboardList, Loader2, PackageCheck, Pencil, Power, ScrollText } from "lucide-react";

import * as supplierService from "@/services/supplier.service";
import * as auditService from "@/services/audit.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Pagination } from "@/components/ui/Pagination";
import { actionLabel, actionTone, relativeTime, TONE_CLASSES } from "@/components/dashboard/audit/auditDisplay";
import { AuditTrailSkeleton } from "@/components/dashboard/audit/AuditTrailSkeleton";
import type { AuditEntry, PagedAuditLogs } from "@/types/audit";
import type { Supplier } from "@/types/supplier";
import type { UserStatus } from "@/types/user";

const AUDIT_PAGE_SIZE = 20;

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// The displayed payment term — "Custom" shows the free-text value.
function paymentTermsLabel(s: Supplier): string {
  if (!s.paymentTerms) return "—";
  if (s.paymentTerms === "Custom") return s.customPaymentTerms || "Custom";
  return s.paymentTerms;
}

type Tab = "overview" | "items" | "purchase-orders" | "goods-in" | "audit";
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "items", label: "Items" },
  { key: "purchase-orders", label: "Purchase Orders" },
  { key: "goods-in", label: "Goods In" },
  { key: "audit", label: "Audit trail" },
];

export function SupplierDetail({ initial }: { initial: Supplier }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const [s, setS] = React.useState<Supplier>(initial);
  const [busy, setBusy] = React.useState(false);

  const requestedTab = searchParams.get("tab");
  const tab: Tab = TABS.find((t) => t.key === requestedTab)?.key ?? "overview";
  const selectTab = (key: Tab) =>
    router.replace(`/dashboard/suppliers/${s.code}?tab=${key}`, { scroll: false });
  const canEdit = can("suppliers.edit");

  const toggleStatus = async () => {
    const next = s.status === "active" ? "inactive" : "active";
    setBusy(true);
    try {
      const updated = await supplierService.updateSupplier(s.id, { status: next });
      setS(updated);
      pushToast(next === "inactive" ? "Supplier deactivated." : "Supplier activated.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not update the supplier.", "alert");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-5">
      {/* Header card */}
      <div
        className="flex shrink-0 flex-col gap-4 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs sm:flex-row sm:items-start sm:justify-between"
        style={{ borderRadius: "var(--radius)" }}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">{s.name}</h1>
            <StatusBadge status={s.status as UserStatus} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <span className="font-mono">{s.code}</span>
            <span aria-hidden>·</span>
            <span>{s.type?.name ?? "—"}</span>
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
              {s.status === "active" ? "Deactivate" : "Activate"}
            </button>
            <button
              type="button"
              onClick={() => router.push(`/dashboard/suppliers/${s.code}/edit`)}
              className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => selectTab(t.key)}
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

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "overview" && <Overview s={s} />}
        {tab === "items" && (
          <Placeholder
            icon={Boxes}
            title="Items"
            body="Catalogue items supplied by this supplier will appear here once the IRM catalogue module is connected."
          />
        )}
        {tab === "purchase-orders" && (
          <Placeholder
            icon={ClipboardList}
            title="Purchase Orders"
            body="Purchase orders raised against this supplier will be listed here once the procurement module is live."
          />
        )}
        {tab === "goods-in" && (
          <Placeholder
            icon={PackageCheck}
            title="Goods In"
            body="Deliveries received from this supplier will be listed here once the goods-in module is live."
          />
        )}
        {tab === "audit" && <AuditTrail supplierId={s.id} />}
      </div>
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

function Overview({ s }: { s: Supplier }) {
  const addressLines = [s.addressLine1, s.addressLine2, s.city, s.county, s.postcode, s.country]
    .map((l) => l?.trim())
    .filter(Boolean);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Business">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Legal business name">{s.legalName}</Field>
          <Field label="Website">
            {s.website ? (
              <a
                className="text-[var(--accent)] hover:underline"
                href={/^https?:\/\//i.test(s.website) ? s.website : `https://${s.website}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {s.website}
              </a>
            ) : (
              ""
            )}
          </Field>
          <Field label="Company reg. number">{s.companyRegistrationNumber}</Field>
          <Field label="VAT number">{s.vatNumber}</Field>
          {s.description && (
            <div className="col-span-2">
              <Field label="Description">{s.description}</Field>
            </div>
          )}
        </div>
      </Card>

      <Card title="Address">
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
      </Card>

      <Card title="Contact">
        <div className="space-y-3">
          <Field label="Contact person">
            {s.contactPerson ? (
              <span>
                {s.contactPerson}
                {s.contactJobTitle && (
                  <span className="ml-1.5 text-xs font-normal text-[var(--muted)]">· {s.contactJobTitle}</span>
                )}
              </span>
            ) : (
              ""
            )}
          </Field>
          <Field label="Email">
            {s.contactEmail ? (
              <a className="text-[var(--accent)] hover:underline" href={`mailto:${s.contactEmail}`}>
                {s.contactEmail}
              </a>
            ) : (
              ""
            )}
          </Field>
          <Field label="Phone">
            {s.contactPhone ? (
              <a className="text-[var(--accent)] hover:underline" href={`tel:${s.contactPhone}`}>
                {s.contactPhone}
              </a>
            ) : (
              ""
            )}
          </Field>
        </div>
      </Card>

      <Card title="Payment & operations">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Payment terms">{paymentTermsLabel(s)}</Field>
          <Field label="Currency">{s.currency}</Field>
          <Field label="Lead time">{s.leadTimeDays != null ? `${s.leadTimeDays} days` : ""}</Field>
          <div className="col-span-2">
            <Field label="Notes">{s.notes}</Field>
          </div>
        </div>
      </Card>

      <Card title="Management">
        <Field label="Internal owner">
          {s.owner ? (
            <div>
              <div className="font-semibold">
                {s.owner.name}
                {s.owner.jobTitle && (
                  <span className="ml-1.5 text-xs font-normal text-[var(--muted)]">· {s.owner.jobTitle}</span>
                )}
              </div>
              <a className="text-xs text-[var(--accent)] hover:underline" href={`mailto:${s.owner.email}`}>
                {s.owner.email}
              </a>
            </div>
          ) : (
            <span className="text-[var(--faint)]">No owner assigned</span>
          )}
        </Field>
      </Card>

      <Card title="Record">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">{s.type?.name ?? "—"}</Field>
          <Field label="Code">{s.code}</Field>
          <Field label="Created">{fmtDate(s.createdAt)}</Field>
          <Field label="Updated">{fmtDate(s.updatedAt)}</Field>
          <Field label="Created by">{s.createdBy}</Field>
          <Field label="Updated by">{s.updatedBy}</Field>
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

// Supplier-specific audit history. The API supports server-side pagination;
// we pass targetId + targetType so the server filters to this supplier's rows.
function AuditTrail({ supplierId }: { supplierId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const page = Math.max(1, Number(searchParams.get("auditPage")) || 1);
  const patchPage = React.useCallback(
    (next: number | null) => {
      const params = new URLSearchParams(window.location.search);
      if (next && next > 1) params.set("auditPage", String(next)); else params.delete("auditPage");
      router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    },
    [router],
  );
  const [result, setResult] = React.useState<PagedAuditLogs | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    auditService
      .listAuditLogs({ targetType: "supplier", targetId: supplierId, page, pageSize: AUDIT_PAGE_SIZE })
      .then((res) => {
        if (!controller.signal.aborted) setResult(res);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load the audit trail.");
      });
    return () => {
      controller.abort();
      setResult(null);
    };
  }, [supplierId, page]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
  if (result === null) return <AuditTrailSkeleton />;

  const entries: AuditEntry[] = result.entries;

  if (result.total === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
        <ScrollText className="h-7 w-7 text-[var(--faint)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">No activity yet</p>
        <p className="text-xs text-[var(--muted)]">Changes to this supplier will be recorded here.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
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
      <Pagination
        page={Math.min(result.page, result.totalPages)}
        totalPages={result.totalPages}
        total={result.total}
        label="entries"
        onPage={(n) => patchPage(n)}
      />
    </div>
  );
}
