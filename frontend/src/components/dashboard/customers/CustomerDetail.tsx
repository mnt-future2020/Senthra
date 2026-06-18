"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Boxes,
  Building2,
  Calendar,
  Check,
  ClipboardList,
  Copy,
  Eye,
  FileText,
  FolderKanban,
  Globe,
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
} from "lucide-react";

import * as customerService from "@/services/customer.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { FormPageHeader, FormSection } from "@/components/ui/FormScaffold";
import { Avatar } from "@/components/ui/Avatar";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { primaryBtn } from "@/components/ui/styles";
import { TempPasswordModal } from "@/components/ui/TempPasswordModal";
import { ProjectModal } from "./ProjectModal";
import { SiteModal } from "./SiteModal";
import { CustomerUserModal } from "./CustomerUserModal";
import type {
  Customer,
  CustomerProject,
  CustomerSite,
  CustomerStockEntry,
  CustomerUser,
  StockRequest,
  WarehouseAssignment,
} from "@/types/customer";
import type { UserStatus } from "@/types/user";
import { EditApproveModal } from "./EditApproveModal";
import { AssignWarehouseModal } from "./AssignWarehouseModal";
import { AdminStockSubmissionModal } from "./AdminStockSubmissionModal";

// The detail page is organised into tabs (URL-driven ?tab=) like the Users & Roles
// panel: the company header stays pinned and each section becomes a tab.
type TabId = "overview" | "projects" | "catalogue" | "submissions" | "sites" | "users";
const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "overview", label: "Overview", icon: Building2 },
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "catalogue", label: "Inventory", icon: Boxes },
  { id: "submissions", label: "Stock Submissions", icon: ClipboardList },
  { id: "sites", label: "Sites", icon: MapPin },
  { id: "users", label: "Portal login", icon: KeyRound },
];

// Each tab beyond Overview is gated by its sub-entity's view permission, so an admin
// without (say) customer_sites.view never sees the Sites tab. The aggregate detail GET
// stays gated by customers.view â€” this is purely tab visibility, no separate read API.
// Overview is the company record itself, so it's always shown (reaching this page
// already required customers.view). Keys mirror the backend PERMISSION_GROUPS.
const TAB_PERMISSION: Record<TabId, string | null> = {
  overview: null,
  projects: "customer_projects.view",
  catalogue: "customer_stock.view",
  submissions: "stock_requests.view",
  sites: "customer_sites.view",
  users: "customer_portal.view",
};

// "10 Jun 2026" â€” en-GB, matching the rest of the dashboard.
function fmtDate(iso: string | null): string {
  if (!iso) return "â€”";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "â€”";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const STATUS_STYLE: Record<string, string> = {
  active: "bg-[var(--pos)]/12 text-[var(--pos)]",
  inactive: "bg-[var(--faint)]/20 text-[var(--muted)]",
  planned: "bg-[var(--accent-10)] text-[var(--accent)]",
  on_hold: "bg-amber-500/15 text-amber-600",
  completed: "bg-[var(--faint)]/20 text-[var(--muted)]",
};
const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  inactive: "Inactive",
  planned: "Planned",
  on_hold: "On hold",
  completed: "Completed",
};
function StatusChip({ value }: { value: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ${STATUS_STYLE[value] ?? STATUS_STYLE.inactive}`}
    >
      {STATUS_LABEL[value] ?? value}
    </span>
  );
}

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

  // Company-record capabilities (the customers.* group governs the company only).
  const canEditCompany = can("customers.edit");
  const canDelete = can("customers.delete");
  const canResendPrimary = can("customer_portal.resend_invite");

  // Per-sub-entity capabilities â€” each customer detail section is gated by its own
  // granular group, matching the backend route permissions.
  const projectCaps = {
    create: can("customer_projects.create"),
    edit: can("customer_projects.edit"),
    delete: can("customer_projects.delete"),
  };
  const stockCaps = {
    create: can("customer_stock.create"),
    edit: can("customer_stock.edit"),
    delete: can("customer_stock.delete"),
  };
  const siteCaps = {
    create: can("customer_sites.create"),
    edit: can("customer_sites.edit"),
    delete: can("customer_sites.delete"),
  };
  const stockReqCaps = {
    approve: can("stock_requests.approve"),
    reject: can("stock_requests.reject"),
  };
  const portalCaps = {
    manage: can("customer_portal.manage"),
    resendInvite: can("customer_portal.resend_invite"),
    resetPassword: can("customer_portal.reset_password"),
  };

  const resend = async () => {
    setResending(true);
    try {
      const { temporaryPassword, email } = await customerService.resendInvite(customer.id);
      setConfirmResend(false);
      setResendCreds({ email, password: temporaryPassword });
      // Re-arm the primary user's first-login locally so the Users tab badge is accurate.
      setCustomer((c) => ({
        ...c,
        users: c.users.map((u) =>
          u.email.toLowerCase() === email.toLowerCase() ? { ...u, mustResetPassword: true } : u,
        ),
      }));
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
  // Only show tabs the user can view; an unauthorised ?tab= falls back to Overview.
  const visibleTabs = TABS.filter((t) => {
    const perm = TAB_PERMISSION[t.id];
    return !perm || can(perm);
  });
  const activeTab: TabId = visibleTabs.find((t) => t.id === requestedTab)?.id ?? "overview";
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
            {canResendPrimary && (
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
            {canEditCompany && (
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

      {/* Tabs â€” URL-driven (?tab=), like the Users & Roles panel. */}
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
        {visibleTabs.map((t) => (
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
        <ProjectsSection customer={customer} caps={projectCaps} onChange={setCustomer} pushToast={pushToast} />
      )}
      {activeTab === "catalogue" && (
        <StockEntriesTab
          customer={customer}
          stockCaps={stockCaps}
          pushToast={pushToast}
          router={router}
        />
      )}
      {activeTab === "submissions" && (
        <StockSubmissionsTab
          customer={customer}
          stockReq={stockReqCaps}
          onChange={setCustomer}
          pushToast={pushToast}
        />
      )}
      {activeTab === "sites" && (
        <SitesSection customer={customer} caps={siteCaps} onChange={setCustomer} pushToast={pushToast} />
      )}
      {activeTab === "users" && (
        <PortalLoginSection customer={customer} caps={portalCaps} onChange={setCustomer} pushToast={pushToast} />
      )}

      <ConfirmDialog
        open={confirmResend}
        title="Re-send invite?"
        message={
          <>
            This generates a new temporary password for{" "}
            <strong className="text-[var(--ink)]">{customer.name}</strong>&apos;s primary portal
            user, emails it, and <strong>invalidates their current password</strong> â€” they&apos;ll
            set a new one on next sign-in. (Manage individual users in the Users tab.)
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

// Overview tab â€” company / contact / address / notes / audit, grouped into cards
// with click-to-email, tap-to-call, and copy affordances.
function OverviewTab({ customer }: { customer: Customer }) {
  const addressLines = [
    customer.addressLine1,
    customer.addressLine2,
    [customer.city, customer.county].filter(Boolean).join(", ") || null,
    customer.postcode,
    customer.country,
  ].filter(Boolean) as string[];

  const websiteHref = customer.website
    ? customer.website.startsWith("http")
      ? customer.website
      : `https://${customer.website}`
    : null;

  // The single portal-login user is the source of truth for the contact + login.
  const login = customer.users[0] ?? null;

  return (
    <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
      <InfoCard title="Company" icon={Building2}>
        <Field label="Customer code">
          <span className="truncate font-mono">{customer.customerCode}</span>
          <CopyButton value={customer.customerCode} label="customer code" />
        </Field>
        <Field label="Status">
          <StatusBadge status={customer.status as UserStatus} />
        </Field>
        <Field label="Legal / registered name">
          <TextValue value={customer.legalName} />
        </Field>
        <Field label="Company / registration no.">
          <TextValue value={customer.registrationNumber} copyLabel="registration number" />
        </Field>
        <Field label="Industry">
          <TextValue value={customer.industry} />
        </Field>
        <Field label="Website">
          {websiteHref ? (
            <>
              <a
                href={websiteHref}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate text-[var(--accent)] hover:underline"
              >
                {customer.website}
              </a>
              <CopyButton value={customer.website ?? ""} label="website" />
            </>
          ) : (
            <Dash />
          )}
        </Field>
        <Field label="Secondary phone">
          <PhoneValue phone={customer.altPhone} />
        </Field>
      </InfoCard>

      {/* Primary contact = the single portal-login user (source of truth). Falls
          back to the company's stored contact only if a login somehow isn't set. */}
      <InfoCard title="Primary contact" icon={UserIcon}>
        {login ? (
          <>
            <Field label="Contact person">
              <TextValue value={login.fullName} />
            </Field>
            <Field label="Job title">
              <TextValue value={login.designation} />
            </Field>
            <Field label="Login email">
              <EmailValue email={login.email} />
            </Field>
            <Field label="Phone">
              <PhoneValue phone={login.phone} />
            </Field>
            <div className="sm:col-span-2">
              <p className="text-[11px] text-[var(--faint)]">
                This is the customer&apos;s portal login â€” manage it in the{" "}
                <span className="font-semibold text-[var(--muted)]">Portal login</span> tab.
              </p>
            </div>
          </>
        ) : (
          <>
            <Field label="Contact person">
              <TextValue value={customer.contactPerson} />
            </Field>
            <Field label="Job title">
              <TextValue value={customer.contactJobTitle} />
            </Field>
            <Field label="Email">
              <EmailValue email={customer.email} />
            </Field>
            <Field label="Phone">
              <PhoneValue phone={customer.phone} />
            </Field>
          </>
        )}
      </InfoCard>

      <InfoCard
        title="Address"
        icon={MapPin}
        singleColumn
        className={customer.notes ? undefined : "lg:col-span-2"}
      >
        {addressLines.length ? (
          <address className="text-sm not-italic leading-relaxed text-[var(--ink)]">
            {addressLines.map((line, i) => (
              <span key={i} className="block">
                {line}
              </span>
            ))}
          </address>
        ) : (
          <Dash />
        )}
      </InfoCard>

      {customer.notes && (
        <InfoCard title="Internal notes" icon={FileText} singleColumn>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--ink)]">
            {customer.notes}
          </p>
        </InfoCard>
      )}

      <InfoCard title="Record" icon={Calendar} className="lg:col-span-2">
        <Field label="Added">
          <span>{fmtDate(customer.createdAt)}</span>
          {customer.createdBy && <span className="truncate text-[var(--muted)]"> Â· {customer.createdBy}</span>}
        </Field>
        <Field label="Last updated">
          <span>{fmtDate(customer.updatedAt)}</span>
          {customer.updatedBy && <span className="truncate text-[var(--muted)]"> Â· {customer.updatedBy}</span>}
        </Field>
      </InfoCard>
    </div>
  );
}

// --- Overview building blocks ----------------------------------------------

function InfoCard({
  title,
  icon: Icon,
  children,
  className,
  singleColumn,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
  className?: string;
  singleColumn?: boolean;
}) {
  return (
    <section
      className={`rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs ${className ?? ""}`}
    >
      <h3 className="mb-4 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">
        <Icon className="h-3.5 w-3.5 text-[var(--faint)]" />
        {title}
      </h3>
      <div className={singleColumn ? "" : "grid gap-x-6 gap-y-4 sm:grid-cols-2"}>{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="group min-w-0">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--faint)]">{label}</p>
      <div className="flex items-center gap-1.5 text-sm text-[var(--ink)]">{children}</div>
    </div>
  );
}

function Dash() {
  return <span className="text-[var(--faint)]">â€”</span>;
}

function TextValue({ value, copyLabel }: { value: string | null; copyLabel?: string }) {
  if (!value) return <Dash />;
  return (
    <>
      <span className="truncate">{value}</span>
      {copyLabel && <CopyButton value={value} label={copyLabel} />}
    </>
  );
}

function EmailValue({ email }: { email: string | null }) {
  if (!email) return <Dash />;
  return (
    <>
      <a href={`mailto:${email}`} className="truncate text-[var(--accent)] hover:underline">
        {email}
      </a>
      <CopyButton value={email} label="email" />
    </>
  );
}

function PhoneValue({ phone }: { phone: string | null }) {
  if (!phone) return <Dash />;
  const tel = phone.replace(/[^\d+]/g, "");
  return (
    <>
      <a href={`tel:${tel}`} className="truncate hover:text-[var(--accent)]">
        {phone}
      </a>
      <CopyButton value={phone} label="phone" />
    </>
  );
}

// Copy-to-clipboard with a brief check-mark confirmation. Always visible (touch-
// friendly) but faint until hovered.
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) â€” silently ignore.
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : `Copy ${label}`}
      title={copied ? "Copied" : `Copy ${label}`}
      className="shrink-0 rounded-md p-1 text-[var(--faint)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-[var(--pos)]" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

type PushToast = (msg: string, type?: "success" | "alert") => void;
// Granular write capabilities for a customer sub-entity section (create / edit /
// delete), matching the backend's per-group route permissions.
type SectionCaps = { create: boolean; edit: boolean; delete: boolean };
type SectionProps = {
  customer: Customer;
  caps: SectionCaps;
  onChange: React.Dispatch<React.SetStateAction<Customer>>;
  pushToast: PushToast;
};

// --- Projects ---------------------------------------------------------------
function ProjectsSection({ customer, caps, onChange, pushToast }: SectionProps) {
  const canWrite = caps.edit || caps.delete;
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CustomerProject | null>(null);

  const onSaved = (project: CustomerProject) => {
    onChange((p) => {
      const exists = p.projects.some((x) => x.id === project.id);
      return {
        ...p,
        projects: exists
          ? p.projects.map((x) => (x.id === project.id ? project : x))
          : [...p.projects, project],
      };
    });
    setOpen(false);
    setEditing(null);
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
      <SectionToolbar
        canEdit={caps.create}
        addLabel="Add project"
        onAdd={() => {
          setEditing(null);
          setOpen(true);
        }}
      />

      {customer.projects.length === 0 ? (
        <Empty>No projects yet.</Empty>
      ) : (
        <TableShell head={["Code", "Project", "Dates", "Status", canWrite ? "" : null]}>
          {customer.projects.map((project) => (
            <tr key={project.id} className="border-b border-[var(--border)] align-top last:border-0">
              <td className="px-3 py-2 font-mono text-xs text-[var(--muted)]">{project.code ?? "â€”"}</td>
              <td className="px-3 py-2">
                <div className="font-semibold text-[var(--ink)]">{project.name}</div>
                {project.type && <div className="text-[11px] text-[var(--muted)]">{project.type}</div>}
              </td>
              <td className="px-3 py-2 text-[var(--muted)]">
                {project.startDate || project.endDate
                  ? `${fmtDate(project.startDate)} â†’ ${fmtDate(project.endDate)}`
                  : "â€”"}
              </td>
              <td className="px-3 py-2"><StatusChip value={project.status} /></td>
              {canWrite && (
                <td className="px-3 py-2">
                  <RowActions
                    canEdit={caps.edit}
                    canDelete={caps.delete}
                    editLabel="Edit project"
                    onEdit={() => {
                      setEditing(project);
                      setOpen(true);
                    }}
                    removeLabel={project.name}
                    onConfirmRemove={() => remove(project)}
                  />
                </td>
              )}
            </tr>
          ))}
        </TableShell>
      )}

      {open && (
        <ProjectModal
          key={editing?.id ?? "new"}
          customerId={customer.id}
          project={editing}
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

// --- Inventory tab (received stock entries) ----------------------------------
function StockEntriesTab({
  customer,
  stockCaps,
  pushToast,
  router,
}: {
  customer: Customer;
  stockCaps: SectionCaps;
  pushToast: PushToast;
  router: ReturnType<typeof useRouter>;
}) {
  // --- stock entries list ---
  const [entries, setEntries] = React.useState<CustomerStockEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<"" | "draft" | "active">("");

  const load = React.useCallback(() => {
    customerService
      .listCustomerStockEntries(customer.id, filter || undefined)
      .then(setEntries)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load stock entries."));
  }, [customer.id, filter]);

  React.useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6">
      {/* Stock entries table */}
      {error ? (
        <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
      ) : entries === null ? (
        <div className="flex items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-16">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--muted)]" />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {(["", "active", "draft"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition-all ${
                  filter === f
                    ? "bg-[var(--accent)] text-white"
                    : "border border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)]"
                }`}
              >
                {f === "" ? "All" : f === "active" ? "Active" : "Draft"}
              </button>
            ))}
            <span className="ml-1 text-xs text-[var(--muted)]">{entries.length} entr{entries.length === 1 ? "y" : "ies"}</span>
            {stockCaps.create && (
              <button
                type="button"
                onClick={() => router.push(`/dashboard/customers/${customer.id}/add-stock-entry`)}
                className={`${primaryBtn} ml-auto`}
              >
                <Plus className="h-4 w-4" /> Add item
              </button>
            )}
          </div>

          {entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
              <Boxes className="h-7 w-7 text-[var(--faint)]" />
              <p className="text-sm font-semibold text-[var(--ink)]">No stock entries</p>
              <p className="text-xs text-[var(--muted)]">
                {filter ? `No ${filter} entries found.` : "Received stock for this customer will appear here."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
              <table className="w-full text-left text-sm" style={{ minWidth: 750 }}>
                <thead>
                  <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                    <th className="px-4 py-3">Item</th>
                    <th className="px-4 py-3">Warehouse</th>
                    <th className="px-4 py-3">SKU</th>
                    <th className="px-4 py-3">Qty</th>
                    <th className="px-4 py-3">Barcode</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Received</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr
                      key={e.id}
                      className="cursor-pointer border-b border-[var(--border)] align-top transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                      onClick={() => router.push(`/dashboard/stock-entries/${e.id}`)}
                    >
                      <td className="px-4 py-3 font-semibold text-[var(--ink)]">{e.itemName}</td>
                      <td className="px-4 py-3">
                        <div className="text-[var(--ink)]">{e.warehouseName}</div>
                        <div className="font-mono text-[11px] text-[var(--faint)]">{e.warehouseCode}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{e.sku ?? "â€”"}</td>
                      <td className="px-4 py-3 font-bold text-[var(--ink)]">{e.quantity}</td>
                      <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{e.barcode ?? "â€”"}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            e.status === "active"
                              ? "bg-[var(--pos)]/12 text-[var(--pos)]"
                              : "bg-amber-500/15 text-amber-600"
                          }`}
                        >
                          {e.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-[var(--muted)]">{fmtDate(e.receivedAt ?? e.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            title="View"
                            onClick={(ev) => { ev.stopPropagation(); router.push(`/dashboard/stock-entries/${e.id}`); }}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)]"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            title="Edit"
                            onClick={(ev) => { ev.stopPropagation(); router.push(`/dashboard/stock-entries/${e.id}`); }}
                            className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-white transition-all hover:opacity-90"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          {stockCaps.delete && (
                            <button
                              type="button"
                              title="Delete"
                              onClick={async (ev) => {
                                ev.stopPropagation();
                                if (!confirm(`Delete "${e.itemName}"?`)) return;
                                try {
                                  await customerService.deleteStockEntry(e.id);
                                  pushToast("Stock entry deleted.", "success");
                                  load();
                                } catch (err) {
                                  pushToast(err instanceof Error ? err.message : "Delete failed.", "alert");
                                }
                              }}
                              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--neg)]/30 bg-[var(--neg)]/10 text-[var(--neg)] transition-all hover:bg-[var(--neg)] hover:text-white"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

    </div>
  );
}

// --- Stock Submissions tab (customer-submitted stock, pending review/receive) -
function StockSubmissionsTab({
  customer,
  stockReq,
  onChange,
  pushToast,
}: {
  customer: Customer;
  stockReq: { approve: boolean; reject: boolean };
  onChange: React.Dispatch<React.SetStateAction<Customer>>;
  pushToast: PushToast;
}) {
  const [reviewingId, setReviewingId] = React.useState<string | null>(null);
  const [rejectingId, setRejectingId] = React.useState<string | null>(null);
  const [rejectNote, setRejectNote] = React.useState("");
  const [editApproveReq, setEditApproveReq] = React.useState<StockRequest | null>(null);
  const [assignReq, setAssignReq] = React.useState<StockRequest | null>(null);
  const [showCreate, setShowCreate] = React.useState(false);

  const onCreated = (created: StockRequest) => {
    onChange((p) => ({ ...p, stockRequests: [created, ...p.stockRequests] }));
    setShowCreate(false);
    pushToast(`Submission created for "${created.name}".`, "success");
  };

  const approve = async (req: StockRequest) => {
    setReviewingId(req.id);
    try {
      const updated = await customerService.approveStockRequest(customer.id, req.id);
      onChange((p) => ({
        ...p,
        stockRequests: p.stockRequests.map((x) => (x.id === updated.id ? updated : x)),
      }));
      pushToast(`Approved "${req.name}".`, "success");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not approve the request.", "alert");
    } finally {
      setReviewingId(null);
    }
  };

  const reject = async (req: StockRequest) => {
    setReviewingId(req.id);
    try {
      await customerService.rejectStockRequest(customer.id, req.id, rejectNote.trim() || undefined);
      onChange((p) => ({ ...p, stockRequests: p.stockRequests.filter((x) => x.id !== req.id) }));
      setRejectingId(null);
      setRejectNote("");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not reject the request.", "alert");
    } finally {
      setReviewingId(null);
    }
  };

  const onEditApproved = (updated: StockRequest) => {
    onChange((p) => ({
      ...p,
      stockRequests: p.stockRequests.map((x) => (x.id === updated.id ? updated : x)),
    }));
    setEditApproveReq(null);
    pushToast(`Approved "${updated.editedName ?? updated.name}".`, "success");
  };

  const onAssigned = (updated: StockRequest) => {
    onChange((p) => ({
      ...p,
      stockRequests: p.stockRequests.map((x) => (x.id === updated.id ? updated : x)),
    }));
    setAssignReq(null);
    pushToast(`Assigned to ${updated.warehouseAssignments.length} warehouse(s).`, "success");
  };

  return (
    <div className="space-y-6">
      {stockReq.approve && (
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className={primaryBtn}
          >
            <Plus className="h-4 w-4" /> New submission
          </button>
        </div>
      )}

      {customer.stockRequests.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
          <ClipboardList className="h-7 w-7 text-[var(--faint)]" />
          <p className="text-sm font-semibold text-[var(--ink)]">No stock submissions</p>
          <p className="text-xs text-[var(--muted)]">
            Stock the customer submits from their portal — or that you add on their behalf — appears here for review.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">
            <ClipboardList className="h-3.5 w-3.5" />
            Stock submissions ({customer.stockRequests.length})
          </div>
          <div className="divide-y divide-[var(--border)]">
            {customer.stockRequests.map((req) => (
              <div key={req.id} className="px-3 py-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-[var(--ink)]">
                        {req.editedName ?? req.name}
                      </span>
                      {req.editedName && req.editedName !== req.name && (
                        <span className="text-[11px] text-[var(--faint)] line-through">{req.name}</span>
                      )}
                      <span className="rounded-md bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[11px] font-bold text-[var(--muted)]">
                        x{req.quantity ?? "?"}
                      </span>
                      <RequestStatusBadge status={req.status} />
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--faint)]">
                      requested by {req.requestedByName ?? "a portal user"}
                    </div>
                    {req.reason && (
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        <span className="font-semibold text-[var(--faint)]">Reason:</span> {req.reason}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {req.status === "pending" && stockReq.approve && (
                      <>
                        <button
                          type="button"
                          onClick={() => setEditApproveReq(req)}
                          className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-[11px] font-bold text-white transition-all hover:opacity-90"
                        >
                          <Pencil className="h-3 w-3" /> Edit & approve
                        </button>
                        <button
                          type="button"
                          onClick={() => approve(req)}
                          disabled={reviewingId === req.id}
                          className="flex items-center gap-1 rounded-lg bg-[var(--pos)] px-2.5 py-1.5 text-[11px] font-bold text-white transition-all hover:opacity-90 disabled:opacity-60"
                        >
                          {reviewingId === req.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Check className="h-3.5 w-3.5" />
                          )}
                          Approve as-is
                        </button>
                      </>
                    )}
                    {req.status === "pending" && stockReq.reject && (
                      <button
                        type="button"
                        onClick={() => {
                          setRejectingId(rejectingId === req.id ? null : req.id);
                          setRejectNote("");
                        }}
                        disabled={reviewingId === req.id}
                        className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--neg)] transition-all hover:bg-[var(--neg)]/10 disabled:opacity-60"
                      >
                        Reject
                      </button>
                    )}
                    {req.status === "approved" && stockReq.approve && (
                      <button
                        type="button"
                        onClick={() => setAssignReq(req)}
                        className="flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-[11px] font-bold text-white transition-all hover:opacity-90"
                      >
                        Assign warehouses
                      </button>
                    )}
                  </div>
                </div>
                {rejectingId === req.id && (
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <input
                      value={rejectNote}
                      onChange={(e) => setRejectNote(e.target.value)}
                      placeholder="Reason (optional) — shown to the customer"
                      maxLength={500}
                      className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                    />
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => reject(req)}
                        disabled={reviewingId === req.id}
                        className="rounded-lg bg-[var(--neg)] px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-60"
                      >
                        Confirm reject
                      </button>
                      <button
                        type="button"
                        onClick={() => setRejectingId(null)}
                        className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-[11px] font-bold text-[var(--ink)]"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {req.warehouseAssignments.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {req.warehouseAssignments.map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center justify-between rounded-lg bg-[var(--surface-2)] px-2.5 py-1.5 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-[var(--ink)]">{a.warehouseName}</span>
                          {a.warehouseCode && (
                            <span className="font-mono text-[var(--faint)]">{a.warehouseCode}</span>
                          )}
                          <span className="text-[var(--muted)]">
                            {a.receivedQuantity}/{a.quantity} received
                          </span>
                          <AssignmentStatusBadge status={a.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {editApproveReq && (
        <EditApproveModal
          customerId={customer.id}
          request={editApproveReq}
          onClose={() => setEditApproveReq(null)}
          onSaved={onEditApproved}
        />
      )}
      {assignReq && (
        <AssignWarehouseModal
          customerId={customer.id}
          request={assignReq}
          onClose={() => setAssignReq(null)}
          onSaved={onAssigned}
        />
      )}
      {showCreate && (
        <AdminStockSubmissionModal
          customerId={customer.id}
          customerName={customer.name}
          onClose={() => setShowCreate(false)}
          onCreated={onCreated}
        />
      )}
    </div>
  );
}

// --- Sites ------------------------------------------------------------------
function SitesSection({ customer, caps, onChange, pushToast }: SectionProps) {
  const canWrite = caps.edit || caps.delete;
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CustomerSite | null>(null);

  const onSaved = (site: CustomerSite) => {
    onChange((p) => {
      const exists = p.sites.some((x) => x.id === site.id);
      return {
        ...p,
        sites: exists ? p.sites.map((x) => (x.id === site.id ? site : x)) : [...p.sites, site],
      };
    });
    setOpen(false);
    setEditing(null);
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
    <FormSection title="Sites" description="Delivery / installation locations.">
      <SectionToolbar
        canEdit={caps.create}
        addLabel="Add site"
        onAdd={() => {
          setEditing(null);
          setOpen(true);
        }}
      />

      {customer.sites.length === 0 ? (
        <Empty>No sites yet.</Empty>
      ) : (
        <TableShell head={["Code", "Site", "Postcode", "Contact", "Status", canWrite ? "" : null]}>
          {customer.sites.map((site) => (
            <tr key={site.id} className="border-b border-[var(--border)] align-top last:border-0">
              <td className="px-3 py-2 font-mono text-xs text-[var(--muted)]">{site.code ?? "â€”"}</td>
              <td className="px-3 py-2">
                <div className="font-semibold text-[var(--ink)]">{site.name}</div>
                {site.addressLine && (
                  <div className="text-[11px] text-[var(--muted)]">{site.addressLine}</div>
                )}
              </td>
              <td className="px-3 py-2 text-[var(--muted)]">{site.postcode ?? "â€”"}</td>
              <td className="px-3 py-2 text-[var(--muted)]">
                {site.contactPerson || site.contactNumber ? (
                  <div>
                    {site.contactPerson && <div className="text-[var(--ink)]">{site.contactPerson}</div>}
                    {site.contactNumber && <div className="text-[11px]">{site.contactNumber}</div>}
                  </div>
                ) : (
                  "â€”"
                )}
              </td>
              <td className="px-3 py-2"><StatusChip value={site.status} /></td>
              {canWrite && (
                <td className="px-3 py-2">
                  <RowActions
                    canEdit={caps.edit}
                    canDelete={caps.delete}
                    editLabel="Edit site"
                    onEdit={() => {
                      setEditing(site);
                      setOpen(true);
                    }}
                    removeLabel={site.name}
                    onConfirmRemove={() => remove(site)}
                  />
                </td>
              )}
            </tr>
          ))}
        </TableShell>
      )}

      {open && (
        <SiteModal
          key={editing?.id ?? "new"}
          customerId={customer.id}
          site={editing}
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

// --- Portal login (the customer's single sign-in) ---------------------------
function PortalLoginSection({
  customer,
  caps,
  onChange,
  pushToast,
}: Omit<SectionProps, "caps"> & {
  caps: { manage: boolean; resendInvite: boolean; resetPassword: boolean };
}) {
  // One login per company â€” the user auto-created with the company.
  const login = customer.users[0] ?? null;
  const [open, setOpen] = React.useState(false);
  // One-time temp-password reveal after creating / re-inviting the login.
  const [creds, setCreds] = React.useState<{ email: string; password: string; resent: boolean } | null>(
    null,
  );
  const [resending, setResending] = React.useState(false);
  const [sendingReset, setSendingReset] = React.useState(false);

  const onSaved = (user: CustomerUser, temporaryPassword?: string) => {
    onChange((p) => {
      const exists = p.users.some((x) => x.id === user.id);
      return {
        ...p,
        users: exists ? p.users.map((x) => (x.id === user.id ? user : x)) : [...p.users, user],
      };
    });
    setOpen(false);
    if (temporaryPassword) setCreds({ email: user.email, password: temporaryPassword, resent: false });
  };

  const resend = async () => {
    if (!login) return;
    setResending(true);
    try {
      const { temporaryPassword, email } = await customerService.resendCustomerUserInvite(
        customer.id,
        login.id,
      );
      setCreds({ email, password: temporaryPassword, resent: true });
      onChange((p) => ({
        ...p,
        users: p.users.map((x) => (x.id === login.id ? { ...x, mustResetPassword: true } : x)),
      }));
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not resend invite.", "alert");
    } finally {
      setResending(false);
    }
  };

  // Admin-initiated reset: emails the customer a secure link to set their OWN
  // password. The admin never sees or sets it (no temp-password reveal here).
  const sendResetLink = async () => {
    if (!login) return;
    setSendingReset(true);
    try {
      const { email } = await customerService.sendCustomerUserResetLink(customer.id, login.id);
      pushToast(`Password reset link sent to ${email}.`, "success");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not send reset link.", "alert");
    } finally {
      setSendingReset(false);
    }
  };

  const hasLoginActions = caps.resendInvite || caps.resetPassword || caps.manage;

  return (
    <FormSection
      title="Portal login"
      description="The customer's single sign-in. Edit it, resend the invite, send a self-serve password reset, or deactivate access."
    >
      {login ? (
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-[var(--ink)]">{login.fullName}</span>
              <StatusChip value={login.status} />
              {login.mustResetPassword && (
                <span className="text-[10px] font-semibold text-[var(--faint)]">
                  awaiting first login
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--muted)]">
              <span className="inline-flex items-center gap-1">
                <Mail className="h-3.5 w-3.5 text-[var(--faint)]" />
                {login.email}
              </span>
              {login.phone && (
                <span className="inline-flex items-center gap-1">
                  <Phone className="h-3.5 w-3.5 text-[var(--faint)]" />
                  {login.phone}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[11px] text-[var(--faint)]">
              Last login: {login.lastLoginAt ? fmtDate(login.lastLoginAt) : "Never"}
            </div>
          </div>
          {hasLoginActions && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {caps.resendInvite && (
                <button
                  type="button"
                  onClick={resend}
                  disabled={resending}
                  className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface)] disabled:opacity-60"
                >
                  {resending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <KeyRound className="h-3.5 w-3.5" />
                  )}
                  Resend invite
                </button>
              )}
              {caps.resetPassword && (
                <button
                  type="button"
                  onClick={sendResetLink}
                  disabled={sendingReset}
                  className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface)] disabled:opacity-60"
                  title="Email the customer a secure link to set their own password"
                >
                  {sendingReset ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Mail className="h-3.5 w-3.5" />
                  )}
                  Send reset link
                </button>
              )}
              {caps.manage && (
                <button
                  type="button"
                  onClick={() => setOpen(true)}
                  className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface)]"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <Empty>No portal login yet.</Empty>
          {caps.manage && (
            <button type="button" onClick={() => setOpen(true)} className={primaryBtn}>
              <Plus className="h-4 w-4" /> Set up login
            </button>
          )}
        </div>
      )}

      {open && (
        <CustomerUserModal
          key={login?.id ?? "new"}
          customerId={customer.id}
          user={login}
          onClose={() => setOpen(false)}
          onSaved={onSaved}
        />
      )}

      {creds && (
        <TempPasswordModal
          open
          title={creds.resent ? "Invite re-sent" : "Login created"}
          portal
          resent={creds.resent}
          email={creds.email}
          password={creds.password}
          onClose={() => setCreds(null)}
        />
      )}
    </FormSection>
  );
}

// --- shared section UI ------------------------------------------------------

function SectionToolbar({
  canEdit,
  addLabel,
  onAdd,
}: {
  canEdit: boolean;
  addLabel: string;
  onAdd: () => void;
}) {
  if (!canEdit) return null;
  return (
    <div className="mb-3 flex justify-end">
      <button type="button" onClick={onAdd} className={primaryBtn}>
        <Plus className="h-4 w-4" /> {addLabel}
      </button>
    </div>
  );
}

function TableShell({
  head,
  children,
}: {
  head: (string | null)[];
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            {head.map((h, i) =>
              h === null ? null : (
                <th key={i} className="px-3 py-2">
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-[var(--muted)]">{children}</p>;
}

function Flag({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
        tone === "warn"
          ? "bg-amber-500/15 text-amber-600"
          : "bg-[var(--surface-2)] text-[var(--muted)]"
      }`}
    >
      {children}
    </span>
  );
}

function RowActions({
  editLabel,
  onEdit,
  removeLabel,
  onConfirmRemove,
  canEdit = true,
  canDelete = true,
}: {
  editLabel: string;
  onEdit: () => void;
  removeLabel: string;
  onConfirmRemove: () => Promise<void>;
  canEdit?: boolean;
  canDelete?: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      {canEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={editLabel}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--faint)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
      {canDelete && <DeleteConfirmButton label={removeLabel} onConfirm={onConfirmRemove} />}
    </div>
  );
}

const REQ_STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-600",
  approved: "bg-[var(--pos)]/12 text-[var(--pos)]",
  rejected: "bg-[var(--neg)]/12 text-[var(--neg)]",
  assigned: "bg-blue-500/12 text-blue-600",
  partially_received: "bg-indigo-500/12 text-indigo-600",
  completed: "bg-[var(--accent-10)] text-[var(--accent)]",
};
function RequestStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${REQ_STATUS_COLORS[status] ?? REQ_STATUS_COLORS.pending}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

const ASSIGN_STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-600",
  partially_received: "bg-indigo-500/12 text-indigo-600",
  received: "bg-[var(--pos)]/12 text-[var(--pos)]",
};
function AssignmentStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${ASSIGN_STATUS_COLORS[status] ?? ASSIGN_STATUS_COLORS.pending}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

// A trash button that confirms before deleting and disables itself while the
// request is in flight (so a double-click can't fire two DELETEs).
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
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Remove"
        className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--faint)] transition-colors hover:bg-[var(--neg)]/10 hover:text-[var(--neg)]"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
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
