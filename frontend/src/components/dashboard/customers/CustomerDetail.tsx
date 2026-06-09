"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  Mail,
  Phone,
  Plus,
  Trash2,
  User as UserIcon,
} from "lucide-react";

import * as customerService from "@/services/customer.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { FormPageHeader, FormSection } from "@/components/ui/FormScaffold";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { CustomerFormModal } from "./CustomerFormModal";
import type {
  CatalogueItem,
  Customer,
  CustomerProject,
  CustomerSite,
  CustomerSummary,
} from "@/types/customer";
import type { UserStatus } from "@/types/user";

export function CustomerDetail({ initial }: { initial: Customer }) {
  const router = useRouter();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  const [customer, setCustomer] = React.useState<Customer>(initial);
  const [editing, setEditing] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [resending, setResending] = React.useState(false);
  const [resendCreds, setResendCreds] = React.useState<{ email: string; password: string } | null>(
    null,
  );

  const canEdit = can("customers.edit");
  const canDelete = can("customers.delete");

  const onEditSaved = (updated: CustomerSummary) => {
    setCustomer((prev) => ({ ...prev, ...updated }));
    pushToast("Customer updated.", "success");
  };

  const resend = async () => {
    setResending(true);
    try {
      const { temporaryPassword } = await customerService.resendInvite(customer.id);
      setResendCreds({ email: customer.email, password: temporaryPassword });
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

  return (
    <div className="space-y-6">
      <FormPageHeader
        title={customer.name}
        subtitle={customer.customerCode}
        onBack={() => router.push("/dashboard/customers")}
        actions={
          <>
            {canEdit && (
              <button
                onClick={resend}
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
              <button onClick={() => setEditing(true)} className={primaryBtn}>
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

      {/* Profile */}
      <FormSection title="Profile">
        <div className="grid gap-4 sm:grid-cols-2">
          <Detail icon={<UserIcon className="h-4 w-4" />} label="Contact person" value={customer.contactPerson} />
          <Detail icon={<Mail className="h-4 w-4" />} label="Login email" value={customer.email} />
          <Detail icon={<Phone className="h-4 w-4" />} label="Phone" value={customer.phone} />
          <div>
            <p className={labelCls}>Status</p>
            <StatusBadge status={customer.status as UserStatus} />
            {customer.mustResetPassword && (
              <span className="ml-2 text-[11px] font-semibold text-[var(--faint)]">
                · awaiting first login
              </span>
            )}
          </div>
        </div>
      </FormSection>

      <ProjectsSection customer={customer} canEdit={canEdit} onChange={setCustomer} pushToast={pushToast} />
      <CatalogueSection customer={customer} canEdit={canEdit} onChange={setCustomer} pushToast={pushToast} />
      <SitesSection customer={customer} canEdit={canEdit} onChange={setCustomer} pushToast={pushToast} />

      {editing && (
        <CustomerFormModal
          mode="edit"
          customer={customer}
          onClose={() => setEditing(false)}
          onSaved={onEditSaved}
        />
      )}

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
        <ResendCredsModal
          email={resendCreds.email}
          password={resendCreds.password}
          onClose={() => setResendCreds(null)}
        />
      )}
    </div>
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
      <p className={labelCls}>{label}</p>
      <p className="flex items-center gap-2 text-sm text-[var(--ink)]">
        <span className="text-[var(--faint)]">{icon}</span>
        {value || <span className="text-[var(--faint)]">—</span>}
      </p>
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
      <ChipList
        items={customer.projects.map((p) => ({ id: p.id, label: p.name }))}
        canEdit={canEdit}
        onRemove={(id) => remove(customer.projects.find((p) => p.id === id)!)}
        emptyLabel="No projects yet."
      />
      {canEdit && (
        <form onSubmit={add} className="mt-3 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Add a project…"
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
  const [name, setName] = React.useState("");
  const [sku, setSku] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !sku.trim() || !category.trim()) return;
    setBusy(true);
    try {
      const item = await customerService.addCatalogueItem(customer.id, {
        name: name.trim(),
        sku: sku.trim(),
        category: category.trim(),
      });
      onChange((p) => ({ ...p, catalogue: [...p.catalogue, item] }));
      setName("");
      setSku("");
      setCategory("");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not add item.", "alert");
    } finally {
      setBusy(false);
    }
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
      {customer.catalogue.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">No catalogue items yet.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)]">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Category</th>
                {canEdit && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {customer.catalogue.map((item) => (
                <tr key={item.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-3 py-2 font-mono text-xs text-[var(--muted)]">{item.sku}</td>
                  <td className="px-3 py-2 font-semibold text-[var(--ink)]">{item.name}</td>
                  <td className="px-3 py-2 text-[var(--muted)]">{item.category}</td>
                  {canEdit && (
                    <td className="px-3 py-2 text-right">
                      <RemoveButton onClick={() => remove(item)} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canEdit && (
        <form onSubmit={add} className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU" className={inputCls} />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Item name" className={inputCls} />
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category" className={inputCls} />
          <AddButton busy={busy} />
        </form>
      )}
    </FormSection>
  );
}

// --- Sites ------------------------------------------------------------------
function SitesSection({ customer, canEdit, onChange, pushToast }: SectionProps) {
  const [name, setName] = React.useState("");
  const [postcode, setPostcode] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const site = await customerService.addSite(customer.id, {
        name: name.trim(),
        postcode: postcode.trim() || undefined,
      });
      onChange((p) => ({ ...p, sites: [...p.sites, site] }));
      setName("");
      setPostcode("");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not add site.", "alert");
    } finally {
      setBusy(false);
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
              className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2 text-sm"
            >
              <span className="text-[var(--ink)]">
                <span className="font-semibold">{site.name}</span>
                {site.postcode && <span className="ml-2 text-[var(--muted)]">{site.postcode}</span>}
              </span>
              {canEdit && <RemoveButton onClick={() => remove(site)} />}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form onSubmit={add} className="mt-3 grid gap-2 sm:grid-cols-[1fr_180px_auto]">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Site name" className={inputCls} />
          <input value={postcode} onChange={(e) => setPostcode(e.target.value)} placeholder="Postcode (optional)" className={inputCls} />
          <AddButton busy={busy} />
        </form>
      )}
    </FormSection>
  );
}

// --- shared small bits ------------------------------------------------------
function ChipList({
  items,
  canEdit,
  onRemove,
  emptyLabel,
}: {
  items: { id: string; label: string }[];
  canEdit: boolean;
  onRemove: (id: string) => void;
  emptyLabel: string;
}) {
  if (items.length === 0) return <p className="text-sm text-[var(--muted)]">{emptyLabel}</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span
          key={item.id}
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)] py-1 pl-3 pr-1.5 text-xs font-semibold text-[var(--ink)]"
        >
          {item.label}
          {canEdit && (
            <button
              onClick={() => onRemove(item.id)}
              aria-label={`Remove ${item.label}`}
              className="flex h-4 w-4 items-center justify-center rounded-full text-[var(--faint)] transition-colors hover:bg-[var(--neg)]/10 hover:text-[var(--neg)]"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
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
      onClick={onClick}
      aria-label="Remove"
      className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--faint)] transition-colors hover:bg-[var(--neg)]/10 hover:text-[var(--neg)]"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}

function ResendCredsModal({
  email,
  password,
  onClose,
}: {
  email: string;
  password: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — value is visible to copy manually
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title="Invite re-sent"
      subtitle={email}
      footer={
        <button onClick={onClose} className={primaryBtn}>
          Done
        </button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-[var(--muted)]">
          A new portal access email has been sent to{" "}
          <strong className="text-[var(--ink)]">{email}</strong>. The temporary password below
          won&apos;t be shown again.
        </p>
        <div>
          <label className={labelCls}>Temporary password</label>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 font-mono text-sm text-[var(--ink)]">
              {password}
            </code>
            <button onClick={copy} className={ghostBtn}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
