"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Building2,
  Calendar,
  Check,
  ClipboardList,
  Copy,
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
import { CatalogueItemModal } from "./CatalogueItemModal";
import { getCachedCategories, listCategories } from "@/services/category.service";
import { ProjectModal } from "./ProjectModal";
import { SiteModal } from "./SiteModal";
import { CustomerUserModal } from "./CustomerUserModal";
import type {
  CatalogueItem,
  Customer,
  CustomerProject,
  CustomerSite,
  CustomerUser,
  StockRequest,
} from "@/types/customer";
import type { UserStatus } from "@/types/user";

// The detail page is organised into tabs (URL-driven ?tab=) like the Users & Roles
// panel: the company header stays pinned and each section becomes a tab.
type TabId = "overview" | "projects" | "catalogue" | "sites" | "users";
const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "overview", label: "Overview", icon: Building2 },
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "catalogue", label: "Stock catalogue", icon: Package },
  { id: "sites", label: "Sites", icon: MapPin },
  { id: "users", label: "Portal login", icon: KeyRound },
];

// Each tab beyond Overview is gated by its sub-entity's view permission, so an admin
// without (say) customer_sites.view never sees the Sites tab. The aggregate detail GET
// stays gated by customers.view — this is purely tab visibility, no separate read API.
// Overview is the company record itself, so it's always shown (reaching this page
// already required customers.view). Keys mirror the backend PERMISSION_GROUPS.
const TAB_PERMISSION: Record<TabId, string | null> = {
  overview: null,
  projects: "customer_projects.view",
  catalogue: "customer_stock.view",
  sites: "customer_sites.view",
  users: "customer_portal.view",
};

// "10 Jun 2026" — en-GB, matching the rest of the dashboard.
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
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

  // Per-sub-entity capabilities — each customer detail section is gated by its own
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

      {/* Tabs — URL-driven (?tab=), like the Users & Roles panel. */}
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
        <CatalogueSection
          customer={customer}
          caps={stockCaps}
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
            user, emails it, and <strong>invalidates their current password</strong> — they&apos;ll
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

// Overview tab — company / contact / address / notes / audit, grouped into cards
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
                This is the customer&apos;s portal login — manage it in the{" "}
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
          {customer.createdBy && <span className="truncate text-[var(--muted)]"> · {customer.createdBy}</span>}
        </Field>
        <Field label="Last updated">
          <span>{fmtDate(customer.updatedAt)}</span>
          {customer.updatedBy && <span className="truncate text-[var(--muted)]"> · {customer.updatedBy}</span>}
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
  return <span className="text-[var(--faint)]">—</span>;
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
      // Clipboard API unavailable (e.g. insecure context) — silently ignore.
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
              <td className="px-3 py-2 font-mono text-xs text-[var(--muted)]">{project.code ?? "—"}</td>
              <td className="px-3 py-2">
                <div className="font-semibold text-[var(--ink)]">{project.name}</div>
                {project.type && <div className="text-[11px] text-[var(--muted)]">{project.type}</div>}
              </td>
              <td className="px-3 py-2 text-[var(--muted)]">
                {project.startDate || project.endDate
                  ? `${fmtDate(project.startDate)} → ${fmtDate(project.endDate)}`
                  : "—"}
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

// --- Catalogue --------------------------------------------------------------
function CatalogueSection({
  customer,
  caps,
  stockReq,
  onChange,
  pushToast,
}: SectionProps & { stockReq: { approve: boolean; reject: boolean } }) {
  const canWrite = caps.edit || caps.delete;
  const canReview = stockReq.approve || stockReq.reject;
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CatalogueItem | null>(null);

  // The global active category list feeds the catalogue-item picker. Seed from the
  // SWR cache for an instant render, then refresh.
  const [categories, setCategories] = React.useState<{ id: string; name: string }[]>(() =>
    (getCachedCategories() ?? [])
      .filter((c) => c.status === "active")
      .map((c) => ({ id: c.id, name: c.name })),
  );
  React.useEffect(() => {
    listCategories()
      .then((cats) =>
        setCategories(
          cats.filter((c) => c.status === "active").map((c) => ({ id: c.id, name: c.name })),
        ),
      )
      .catch(() => {});
  }, []);

  const q = query.trim().toLowerCase();
  const items = q
    ? customer.catalogue.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.sku.toLowerCase().includes(q) ||
          (i.category?.name ?? "").toLowerCase().includes(q),
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

  // --- pending stock requests (customer-submitted; internal users review here) ---
  const [reviewingId, setReviewingId] = React.useState<string | null>(null);
  const [rejectingId, setRejectingId] = React.useState<string | null>(null);
  const [rejectNote, setRejectNote] = React.useState("");

  // Approving is a STATUS MOVE ONLY — it never creates a catalogue item or inventory
  // record (that's a later, deliberate internal step). We just drop the request from
  // the pending queue.
  const approve = async (req: StockRequest) => {
    setReviewingId(req.id);
    try {
      await customerService.approveStockRequest(customer.id, req.id);
      onChange((p) => ({
        ...p,
        stockRequests: p.stockRequests.filter((x) => x.id !== req.id),
      }));
      pushToast(`Approved the request for "${req.name}".`, "success");
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

  return (
    <FormSection
      title="Stock catalogue"
      description="The items this customer's stock is tracked against (per-customer SKUs)."
    >
      {canReview && customer.stockRequests.length > 0 && (
        <div className="mb-4 overflow-hidden rounded-xl border border-amber-500/30 bg-amber-500/5">
          <div className="flex items-center gap-2 border-b border-amber-500/20 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-amber-600">
            <ClipboardList className="h-3.5 w-3.5" />
            {customer.stockRequests.length} pending request
            {customer.stockRequests.length === 1 ? "" : "s"} from this customer
          </div>
          <div className="divide-y divide-[var(--border)]">
            {customer.stockRequests.map((req) => (
              <div key={req.id} className="px-3 py-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-[var(--ink)]">{req.name}</span>
                      <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 font-mono text-[11px] font-bold text-amber-700">
                        ×{req.quantity ?? "?"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--faint)]">
                      requested by {req.requestedByName ?? "a portal user"}
                    </div>
                    {req.reason && (
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        <span className="font-semibold text-[var(--faint)]">Reason:</span>{" "}
                        {req.reason}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {stockReq.approve && (
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
                        Approve
                      </button>
                    )}
                    {stockReq.reject && (
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
              </div>
            ))}
          </div>
        </div>
      )}

      {(customer.catalogue.length > 0 || caps.create) && (
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
          <span className="text-xs text-[var(--muted)] sm:ml-1">
            {customer.catalogue.length} item{customer.catalogue.length === 1 ? "" : "s"}
          </span>
          {caps.create && (
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
        <Empty>No catalogue items yet.</Empty>
      ) : items.length === 0 ? (
        <Empty>No items match your search.</Empty>
      ) : (
        <TableShell head={["SKU", "Item", "Category", "UoM", "Threshold", "Status", canWrite ? "" : null]}>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-[var(--border)] align-top last:border-0">
              <td className="px-3 py-2 font-mono text-xs text-[var(--muted)]">{item.sku}</td>
              <td className="px-3 py-2">
                <div className="font-semibold text-[var(--ink)]">{item.name}</div>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {item.serialized && <Flag>Serial</Flag>}
                  {item.barcodeRequired && <Flag>Barcode</Flag>}
                  {item.highValue && <Flag tone="warn">High value</Flag>}
                </div>
              </td>
              <td className="px-3 py-2 text-[var(--muted)]">{item.category?.name ?? "—"}</td>
              <td className="px-3 py-2 text-[var(--muted)]">{item.uom ?? "—"}</td>
              <td className="px-3 py-2 text-[var(--muted)]">{item.thresholdQty ?? "—"}</td>
              <td className="px-3 py-2"><StatusChip value={item.status} /></td>
              {canWrite && (
                <td className="px-3 py-2">
                  <RowActions
                    canEdit={caps.edit}
                    canDelete={caps.delete}
                    editLabel="Edit item"
                    onEdit={() => {
                      setEditing(item);
                      setOpen(true);
                    }}
                    removeLabel={item.sku}
                    onConfirmRemove={() => remove(item)}
                  />
                </td>
              )}
            </tr>
          ))}
        </TableShell>
      )}

      {open && (
        <CatalogueItemModal
          key={editing?.id ?? "new"}
          customerId={customer.id}
          item={editing}
          categories={categories}
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
              <td className="px-3 py-2 font-mono text-xs text-[var(--muted)]">{site.code ?? "—"}</td>
              <td className="px-3 py-2">
                <div className="font-semibold text-[var(--ink)]">{site.name}</div>
                {site.addressLine && (
                  <div className="text-[11px] text-[var(--muted)]">{site.addressLine}</div>
                )}
              </td>
              <td className="px-3 py-2 text-[var(--muted)]">{site.postcode ?? "—"}</td>
              <td className="px-3 py-2 text-[var(--muted)]">
                {site.contactPerson || site.contactNumber ? (
                  <div>
                    {site.contactPerson && <div className="text-[var(--ink)]">{site.contactPerson}</div>}
                    {site.contactNumber && <div className="text-[11px]">{site.contactNumber}</div>}
                  </div>
                ) : (
                  "—"
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
  // One login per company — the user auto-created with the company.
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
