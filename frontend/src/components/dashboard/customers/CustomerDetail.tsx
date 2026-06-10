"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Briefcase,
  Building2,
  Check,
  FileText,
  FolderKanban,
  Globe,
  Hash,
  KeyRound,
  Loader2,
  Mail,
  MapPin,
  Package,
  Pencil,
  Phone,
  Plus,
  Search,
  Trash2,
  User as UserIcon,
  X,
} from "lucide-react";

import * as customerService from "@/services/customer.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { FormPageHeader, FormSection } from "@/components/ui/FormScaffold";
import { Avatar } from "@/components/ui/Avatar";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { inputCls, primaryBtn } from "@/components/ui/styles";
import { TempPasswordModal } from "@/components/ui/TempPasswordModal";
import { CatalogueItemModal, UOM_KEY } from "./CatalogueItemModal";
import type {
  CatalogueItem,
  Customer,
  CustomerProject,
  CustomerSite,
} from "@/types/customer";
import type { UserStatus } from "@/types/user";
import { UK_POSTCODE_RE } from "@/lib/validation";

// The detail page is organised into tabs (URL-driven ?tab=) like the Users & Roles
// panel: the company header stays pinned and each section becomes a tab.
type TabId = "overview" | "projects" | "catalogue" | "sites";
const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "overview", label: "Overview", icon: Building2 },
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "catalogue", label: "Stock catalogue", icon: Package },
  { id: "sites", label: "Sites", icon: MapPin },
];

export function CustomerDetail({ initial }: { initial: Customer }) {
  const router = useRouter();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  const [customer, setCustomer] = React.useState<Customer>(initial);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [confirmResend, setConfirmResend] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [resending, setResending] = React.useState(false);
  const [resendCreds, setResendCreds] = React.useState<{ email: string; password: string } | null>(
    null,
  );

  const canEdit = can("customers.edit");
  const canDelete = can("customers.delete");

  const resend = async () => {
    setResending(true);
    try {
      const { temporaryPassword } = await customerService.resendInvite(customer.id);
      setConfirmResend(false);
      setResendCreds({ email: customer.email, password: temporaryPassword });
      // Resend regenerates a temp password and re-arms first-login on the backend;
      // mirror it locally so the "awaiting first login" badge reflects reality
      // without needing a refetch.
      setCustomer((c) => ({ ...c, mustResetPassword: true }));
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not resend invite.", "alert");
    } finally {
      setResending(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await customerService.deleteCustomer(customer.id);
      pushToast("Customer removed.", "success");
      router.push("/dashboard/customers");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
      setDeleting(false);
    }
  };

  const websiteHref = customer.website
    ? customer.website.startsWith("http")
      ? customer.website
      : `https://${customer.website}`
    : null;

  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const activeTab: TabId = TABS.find((t) => t.id === requestedTab)?.id ?? "overview";
  const selectTab = (t: TabId) =>
    router.replace(`/dashboard/customers/${customer.customerCode}?tab=${t}`, { scroll: false });

  return (
    <div className="space-y-6">
      <FormPageHeader
        title="Customer details"
        subtitle={customer.email}
        onBack={() => router.push("/dashboard/customers")}
        actions={
          <>
            {canEdit && (
              <button
                onClick={() => setConfirmResend(true)}
                disabled={resending}
                className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:opacity-60"
              >
                {resending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <KeyRound className="h-3.5 w-3.5" />
                )}
                Resend invite
              </button>
            )}
            {canEdit && (
              <button
                onClick={() => router.push(`/dashboard/customers/${customer.customerCode}/edit`)}
                className={primaryBtn}
              >
                Edit
              </button>
            )}
            {canDelete && (
              <button
                onClick={() => setConfirmDelete(true)}
                aria-label="Delete customer"
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--neg)] transition-all hover:bg-[var(--neg)]/10"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </>
        }
      />

      {/* Company card */}
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs">
        <Avatar url={customer.logoUrl} firstName={customer.name || "?"} lastName="" size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-extrabold tracking-tight text-[var(--ink)]">
              {customer.name}
            </h1>
            <StatusBadge status={customer.status as UserStatus} />
            {customer.mustResetPassword && (
              <span className="text-[11px] font-semibold text-[var(--faint)]">
                · awaiting first login
              </span>
            )}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--muted)]">
            <span className="font-mono">{customer.customerCode}</span>
            {customer.industry && <span>{customer.industry}</span>}
            {websiteHref && (
              <a
                href={websiteHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[var(--accent)] hover:opacity-80"
              >
                <Globe className="h-3 w-3" />
                {customer.website}
              </a>
            )}
          </p>
        </div>
      </div>

      {/* Tabs — URL-driven (?tab=), like the Users & Roles panel. */}
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => selectTab(t.id)}
            className={`flex shrink-0 items-center gap-2 rounded-lg px-4 py-2 text-xs font-bold transition-all ${
              activeTab === t.id
                ? "bg-[var(--accent)] text-white shadow-xs"
                : "text-[var(--muted)] hover:text-[var(--ink)]"
            }`}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "overview" && <OverviewTab customer={customer} />}
      {activeTab === "projects" && (
        <ProjectsSection customer={customer} canEdit={canEdit} onChange={setCustomer} pushToast={pushToast} />
      )}
      {activeTab === "catalogue" && (
        <CatalogueSection customer={customer} canEdit={canEdit} onChange={setCustomer} pushToast={pushToast} />
      )}
      {activeTab === "sites" && (
        <SitesSection customer={customer} canEdit={canEdit} onChange={setCustomer} pushToast={pushToast} />
      )}

      <ConfirmDialog
        open={confirmResend}
        title="Re-send invite?"
        message={
          <>
            This generates a new temporary password for{" "}
            <strong className="text-[var(--ink)]">{customer.name}</strong>, emails it, and
            <strong> invalidates their current password</strong> — they&apos;ll have to set a new
            one on next sign-in.
          </>
        }
        confirmLabel="Re-send invite"
        busy={resending}
        onConfirm={resend}
        onClose={() => setConfirmResend(false)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="Remove customer?"
        message={
          <>
            This removes <strong className="text-[var(--ink)]">{customer.name}</strong> and revokes
            their portal access. This can be undone by re-adding them.
          </>
        }
        confirmLabel="Remove"
        danger
        busy={deleting}
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      />

      {resendCreds && (
        <TempPasswordModal
          open
          title="Invite re-sent"
          portal
          resent
          email={resendCreds.email}
          password={resendCreds.password}
          onClose={() => setResendCreds(null)}
        />
      )}
    </div>
  );
}

// Overview tab — the company / contact / address / notes details (read-only).
function OverviewTab({ customer }: { customer: Customer }) {
  const addressLines = [
    customer.addressLine1,
    customer.addressLine2,
    [customer.city, customer.county].filter(Boolean).join(", ") || null,
    customer.postcode,
  ].filter(Boolean) as string[];

  return (
    <FormSection title="Details">
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <Detail icon={<Hash className="h-4 w-4" />} label="Company / registration no." value={customer.registrationNumber} />
        <Detail icon={<Building2 className="h-4 w-4" />} label="Industry" value={customer.industry} />
        <Detail icon={<UserIcon className="h-4 w-4" />} label="Contact person" value={customer.contactPerson} />
        <Detail icon={<Briefcase className="h-4 w-4" />} label="Contact job title" value={customer.contactJobTitle} />
        <Detail icon={<Mail className="h-4 w-4" />} label="Login email" value={customer.email} />
        <Detail icon={<Phone className="h-4 w-4" />} label="Phone" value={customer.phone} />
        <Detail icon={<Phone className="h-4 w-4" />} label="Secondary phone" value={customer.altPhone} />
        <div>
          <p className="mb-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
            <MapPin className="h-3.5 w-3.5 text-[var(--faint)]" /> Address
          </p>
          {addressLines.length ? (
            <p className="text-sm leading-relaxed text-[var(--ink)]">
              {addressLines.map((line, i) => (
                <span key={i} className="block">
                  {line}
                </span>
              ))}
            </p>
          ) : (
            <p className="text-sm text-[var(--faint)]">—</p>
          )}
        </div>
      </div>
      {customer.notes && (
        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
            <FileText className="h-3.5 w-3.5 text-[var(--faint)]" /> Internal notes
          </p>
          <p className="whitespace-pre-wrap text-sm text-[var(--ink)]">{customer.notes}</p>
        </div>
      )}
    </FormSection>
  );
}

function Detail({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
}) {
  return (
    <div>
      <p className="mb-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
        <span className="text-[var(--faint)]">{icon}</span>
        {label}
      </p>
      <p className="text-sm text-[var(--ink)]">{value || <span className="text-[var(--faint)]">—</span>}</p>
    </div>
  );
}

type PushToast = (msg: string, type?: "success" | "alert") => void;
type SectionProps = {
  customer: Customer;
  canEdit: boolean;
  onChange: React.Dispatch<React.SetStateAction<Customer>>;
  pushToast: PushToast;
};

// --- Projects ---------------------------------------------------------------
function ProjectsSection({ customer, canEdit, onChange, pushToast }: SectionProps) {
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [savingEdit, setSavingEdit] = React.useState(false);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const project = await customerService.addProject(customer.id, name.trim());
      onChange((p) => ({ ...p, projects: [...p.projects, project] }));
      setName("");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not add project.", "alert");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (project: CustomerProject) => {
    const v = draft.trim();
    if (!v) return;
    if (v === project.name) {
      setEditingId(null);
      return;
    }
    setSavingEdit(true);
    try {
      const updated = await customerService.updateProject(customer.id, project.id, v);
      onChange((p) => ({ ...p, projects: p.projects.map((x) => (x.id === project.id ? updated : x)) }));
      setEditingId(null);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not rename project.", "alert");
    } finally {
      setSavingEdit(false);
    }
  };

  const remove = async (project: CustomerProject) => {
    try {
      await customerService.deleteProject(customer.id, project.id);
      onChange((p) => ({ ...p, projects: p.projects.filter((x) => x.id !== project.id) }));
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not remove project.", "alert");
    }
  };

  return (
    <FormSection title="Projects" description="The customer's projects (used when creating jobs).">
      {customer.projects.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">No projects yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {customer.projects.map((project) => (
            <li
              key={project.id}
              className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm"
            >
              {editingId === project.id ? (
                <>
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void saveEdit(project);
                      }
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    maxLength={120}
                    className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                  />
                  <SaveCancel busy={savingEdit} onSave={() => void saveEdit(project)} onCancel={() => setEditingId(null)} />
                </>
              ) : (
                <>
                  <span className="flex-1 font-semibold text-[var(--ink)]">{project.name}</span>
                  {canEdit && (
                    <RowActions
                      onEdit={() => {
                        setEditingId(project.id);
                        setDraft(project.name);
                      }}
                      onConfirmRemove={() => remove(project)}
                      removeLabel={project.name}
                    />
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form onSubmit={add} className="mt-3 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Add a project…"
            maxLength={120}
            className={inputCls}
          />
          <AddButton busy={busy} />
        </form>
      )}
    </FormSection>
  );
}

// --- Catalogue --------------------------------------------------------------
function CatalogueSection({ customer, canEdit, onChange, pushToast }: SectionProps) {
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CatalogueItem | null>(null);

  const q = query.trim().toLowerCase();
  const items = q
    ? customer.catalogue.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.sku.toLowerCase().includes(q) ||
          i.category.toLowerCase().includes(q),
      )
    : customer.catalogue;

  const onSaved = (item: CatalogueItem) => {
    onChange((p) => {
      const exists = p.catalogue.some((x) => x.id === item.id);
      return {
        ...p,
        catalogue: exists
          ? p.catalogue.map((x) => (x.id === item.id ? item : x))
          : [...p.catalogue, item],
      };
    });
    setOpen(false);
    setEditing(null);
  };

  const remove = async (item: CatalogueItem) => {
    try {
      await customerService.deleteCatalogueItem(customer.id, item.id);
      onChange((p) => ({ ...p, catalogue: p.catalogue.filter((x) => x.id !== item.id) }));
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not remove item.", "alert");
    }
  };

  return (
    <FormSection
      title="Stock catalogue"
      description="The items this customer's stock is tracked against (per-customer SKUs)."
    >
      {(customer.catalogue.length > 0 || canEdit) && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          {customer.catalogue.length > 0 && (
            <div className="relative w-full sm:max-w-xs">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search SKU, item or category…"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2 pl-9 pr-3 text-xs text-[var(--ink)] outline-none focus:border-[var(--accent)]"
              />
            </div>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
              className={`${primaryBtn} sm:ml-auto`}
            >
              <Plus className="h-4 w-4" /> Add item
            </button>
          )}
        </div>
      )}

      {customer.catalogue.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">No catalogue items yet.</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">No items match your search.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Unit</th>
                <th className="px-3 py-2">Details</th>
                {canEdit && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const attrs: Record<string, string> = item.attributes ?? {};
                const uom = attrs[UOM_KEY] ?? null;
                const custom = Object.entries(attrs).filter(([k]) => k !== UOM_KEY);
                return (
                  <tr key={item.id} className="border-b border-[var(--border)] align-top last:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-[var(--muted)]">{item.sku}</td>
                    <td className="px-3 py-2 font-semibold text-[var(--ink)]">{item.name}</td>
                    <td className="px-3 py-2 text-[var(--muted)]">{item.category}</td>
                    <td className="px-3 py-2 text-[var(--muted)]">{uom ?? "—"}</td>
                    <td className="px-3 py-2">
                      {custom.length === 0 ? (
                        <span className="text-[var(--faint)]">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {custom.map(([k, v]) => (
                            <span
                              key={k}
                              className="inline-flex items-center gap-1 rounded-md bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]"
                            >
                              <span className="font-semibold text-[var(--ink)]">{k}</span>
                              {String(v) && <span>{String(v)}</span>}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    {canEdit && (
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setEditing(item);
                              setOpen(true);
                            }}
                            aria-label="Edit item"
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--faint)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <DeleteConfirmButton label={item.sku} onConfirm={() => remove(item)} />
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <CatalogueItemModal
          key={editing?.id ?? "new"}
          customerId={customer.id}
          item={editing}
          onClose={() => {
            setOpen(false);
            setEditing(null);
          }}
          onSaved={onSaved}
        />
      )}
    </FormSection>
  );
}

// --- Sites ------------------------------------------------------------------
function SitesSection({ customer, canEdit, onChange, pushToast }: SectionProps) {
  const [name, setName] = React.useState("");
  const [postcode, setPostcode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [pcError, setPcError] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draftName, setDraftName] = React.useState("");
  const [draftPc, setDraftPc] = React.useState("");
  const [editPcError, setEditPcError] = React.useState<string | null>(null);
  const [savingEdit, setSavingEdit] = React.useState(false);

  const validPc = (v: string) => !v.trim() || UK_POSTCODE_RE.test(v.trim());

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (!validPc(postcode)) {
      setPcError("Enter a valid UK postcode (e.g. EC1A 1BB).");
      return;
    }
    setBusy(true);
    try {
      const site = await customerService.addSite(customer.id, {
        name: name.trim(),
        postcode: postcode.trim() || undefined,
      });
      onChange((p) => ({ ...p, sites: [...p.sites, site] }));
      setName("");
      setPostcode("");
      setPcError(null);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not add site.", "alert");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (site: CustomerSite) => {
    if (!draftName.trim()) return;
    if (!validPc(draftPc)) {
      setEditPcError("Enter a valid UK postcode.");
      return;
    }
    setSavingEdit(true);
    try {
      const updated = await customerService.updateSite(customer.id, site.id, {
        name: draftName.trim(),
        postcode: draftPc.trim() || undefined,
      });
      onChange((p) => ({ ...p, sites: p.sites.map((x) => (x.id === site.id ? updated : x)) }));
      setEditingId(null);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not update site.", "alert");
    } finally {
      setSavingEdit(false);
    }
  };

  const remove = async (site: CustomerSite) => {
    try {
      await customerService.deleteSite(customer.id, site.id);
      onChange((p) => ({ ...p, sites: p.sites.filter((x) => x.id !== site.id) }));
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not remove site.", "alert");
    }
  };

  return (
    <FormSection title="Sites" description="Optional delivery/installation locations.">
      {customer.sites.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">No sites yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {customer.sites.map((site) => (
            <li
              key={site.id}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm"
            >
              {editingId === site.id ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder="Site name"
                      maxLength={120}
                      className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                    />
                    <input
                      value={draftPc}
                      onChange={(e) => {
                        setDraftPc(e.target.value);
                        setEditPcError(null);
                      }}
                      placeholder="Postcode"
                      maxLength={12}
                      className="w-32 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                    />
                    <SaveCancel busy={savingEdit} onSave={() => void saveEdit(site)} onCancel={() => setEditingId(null)} />
                  </div>
                  {editPcError && <p className="text-[11px] font-semibold text-[var(--neg)]">{editPcError}</p>}
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[var(--ink)]">
                    <span className="font-semibold">{site.name}</span>
                    {site.postcode && <span className="ml-2 text-[var(--muted)]">{site.postcode}</span>}
                  </span>
                  {canEdit && (
                    <RowActions
                      onEdit={() => {
                        setEditingId(site.id);
                        setDraftName(site.name);
                        setDraftPc(site.postcode ?? "");
                        setEditPcError(null);
                      }}
                      onConfirmRemove={() => remove(site)}
                      removeLabel={site.name}
                    />
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form onSubmit={add} className="mt-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_180px_auto]">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Site name"
              maxLength={120}
              className={inputCls}
            />
            <input
              value={postcode}
              onChange={(e) => {
                setPostcode(e.target.value);
                setPcError(null);
              }}
              placeholder="Postcode (optional)"
              maxLength={12}
              aria-invalid={Boolean(pcError)}
              className={inputCls}
            />
            <AddButton busy={busy} />
          </div>
          {pcError && <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{pcError}</p>}
        </form>
      )}
    </FormSection>
  );
}

// --- shared small bits ------------------------------------------------------
function RowActions({
  onEdit,
  onConfirmRemove,
  removeLabel,
}: {
  onEdit: () => void;
  onConfirmRemove: () => Promise<void>;
  removeLabel: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onEdit}
        aria-label="Edit"
        className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--faint)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--ink)]"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <DeleteConfirmButton label={removeLabel} onConfirm={onConfirmRemove} />
    </div>
  );
}

// A trash button that confirms before deleting and disables itself while the
// request is in flight (so a double-click can't fire two DELETEs). Used for the
// nested project / catalogue / site rows, matching the confirm the top-level
// customer delete already has.
function DeleteConfirmButton({
  label,
  onConfirm,
}: {
  label: string;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <RemoveButton onClick={() => setOpen(true)} />
      <ConfirmDialog
        open={open}
        title="Remove?"
        message={
          <>
            Remove <strong className="text-[var(--ink)]">{label}</strong>? This can&apos;t be undone.
          </>
        }
        confirmLabel="Remove"
        danger
        busy={busy}
        onConfirm={run}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
      />
    </>
  );
}

function SaveCancel({
  busy,
  onSave,
  onCancel,
}: {
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onSave}
        disabled={busy}
        aria-label="Save"
        className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--pos)] transition-colors hover:bg-[var(--pos)]/10 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-4 w-4" />}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        aria-label="Cancel"
        className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--faint)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--ink)] disabled:opacity-50"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function AddButton({ busy }: { busy: boolean }) {
  return (
    <button type="submit" disabled={busy} className={primaryBtn}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-4 w-4" />}
      Add
    </button>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Remove"
      className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--faint)] transition-colors hover:bg-[var(--neg)]/10 hover:text-[var(--neg)]"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}
