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
  PackagePlus,
  Pencil,
  Phone,
  Plus,
  Search as SearchIcon,
  Trash2,
  Upload,
  User as UserIcon,
} from "lucide-react";

import * as customerService from "@/services/customer.service";
import { useAuth } from "@/hooks/useAuth";
import { ExportButton } from "@/components/ui/ExportButton";
import { useDashboard } from "@/hooks/useDashboard";
import { useAttention } from "@/hooks/useAttention";
import { useEntityAttention } from "@/hooks/useEntityAttention";
import { CountPill } from "@/components/dashboard/shell/TabCount";
import type { AttentionTone } from "@/services/attention.service";

/** critical &lt; attention &lt; info — lower wins, matching the server's own rollup. */
const TONE_RANK: Record<AttentionTone, number> = { critical: 0, attention: 1, info: 2 };
import { Select } from "@/components/ui/Select";
import { FormPageHeader, FormSection } from "@/components/ui/FormScaffold";
import { Avatar } from "@/components/ui/Avatar";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Skeleton } from "@/components/ui/Skeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { primaryBtn, secondaryBtn, toolbarBtn, toolbarInputCls } from "@/components/ui/styles";
import { searchStockEntries } from "@/lib/stockEntrySearch";
import {
  ALL as ALL_SUBMISSION_STATUSES,
  DEFAULT_SUBMISSION_FILTERS,
  effectiveSubmissionFilters,
  filterSubmissions,
  isActionable,
  hasActiveSubmissionFilter,
  submissionStatusOptions,
  type SubmissionFilters,
} from "./stockSubmissionFilter";
import { Pagination } from "@/components/ui/Pagination";
import { TempPasswordModal } from "@/components/ui/TempPasswordModal";
import { ProjectModal } from "./ProjectModal";
import { SiteModal } from "./SiteModal";
import { SiteImportModal } from "./SiteImportModal";
import { CustomerUserModal } from "./CustomerUserModal";
import type {
  Customer,
  CustomerProject,
  CustomerSite,
  CustomerStockEntry,
  CustomerUser,
  StockRequest,
} from "@/types/customer";
import type { UserStatus } from "@/types/user";
import { EditApproveModal } from "./EditApproveModal";
import { AssignWarehouseModal } from "./AssignWarehouseModal";
import { AdminStockSubmissionModal } from "./AdminStockSubmissionModal";
import { DamagedStockView } from "@/components/dashboard/goods-management/DamagedStockView";
import { formatDate as fmtDate } from "@/lib/formatDate";

// Fallback destination for the back button when there is no in-app history to return to.
const CUSTOMERS_LIST = "/dashboard/customers";

// The detail page is organised into tabs (URL-driven ?tab=) like the Users & Roles
// panel: the company header stays pinned and each section becomes a tab.
type TabId = "overview" | "projects" | "catalogue" | "submissions" | "sites" | "users";
// `attention` names the catalog key whose work is done on that tab. Both customer queues are worked
// here and nowhere else — there is no cross-customer review screen — so this is the end of the chain
// that starts at the sidebar badge and passes through the Customers list's per-row count. Without it
// the row says "2" and the page it opens gives no clue which two tabs to look at.
const TABS: { id: TabId; label: string; icon: React.ElementType; attention?: string[] }[] = [
  { id: "overview", label: "Overview", icon: Building2 },
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "catalogue", label: "Inventory", icon: Boxes },
  // BOTH submission queues, because both are worked on this one tab: reviewing a pending request and
  // routing an approved one to warehouses. Counting only `pending` made the badge disagree with the
  // tab it sits on — it read 2 while the tab opened on 4 rows, two of which were also outstanding.
  { id: "submissions", label: "Stock Submissions", icon: ClipboardList, attention: ["cust.stock_requests", "cust.awaiting_assignment"] },
  { id: "sites", label: "Sites", icon: MapPin },
  { id: "users", label: "Portal login", icon: KeyRound, attention: ["cust.portal_invites"] },
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
  submissions: "stock_requests.view",
  sites: "customer_sites.view",
  users: "customer_portal.view",
};


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

  // This company's own pending work, split per queue. Keys the actor may not act on are already
  // absent server-side, so a tab only ever counts work its viewer could actually do.
  const { rows: customerAttention } = useEntityAttention("customer");
  const { attention } = useAttention();
  const mine = customerAttention[customer.id];
  // Sums the tab's queues and takes the most severe tone among the ones that actually have work. A
  // tab holding two queues has to report BOTH: Stock Submissions counted only `pending`, so it read 2
  // while the tab opened on four rows — two of which were approved requests still waiting to be
  // routed to warehouses, with an "Assign warehouses" button sitting right there.
  const tabAttention = (keys?: string[]) => {
    let count = 0;
    let tone: AttentionTone = "info";
    for (const k of keys ?? []) {
      const n = mine?.keys[k] ?? 0;
      if (n <= 0) continue;
      count += n;
      const t = attention.items.find((i) => i.key === k)?.tone;
      if (t && TONE_RANK[t] < TONE_RANK[tone]) tone = t;
    }
    return { count, tone };
  };

  return (
    <div className="flex h-full flex-col gap-6">
      <div className="shrink-0">
        <FormPageHeader
          title="Customer details"
          subtitle={customer.email}
          onBack={() => { if (window.history.length > 1) router.back(); else router.push(CUSTOMERS_LIST); }}
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
      </div>

      {/* Company card — the shared DetailHeader, so it collapses to one compact line like every
          other detail page (Warehouse, Supplier, Job, PO, PRF, GRN, IRM item, Inventory). This was
          the one detail page still hand-rolling its own header, and so the only one whose card you
          could not collapse to get more rows of the tab below on screen. The choice persists in
          localStorage under this storageKey, shared across all customers. */}
      <DetailHeader
        storageKey="customer-detail"
        title={customer.name}
        badges={<StatusBadge status={customer.status as UserStatus} />}
        // Shrinks with the header — a fixed 56px logo would have pinned the collapsed card to its
        // expanded height and defeated the point.
        avatar={(collapsed) => (
          <Avatar
            url={customer.logoUrl}
            firstName={customer.name || "?"}
            lastName=""
            size={collapsed ? 28 : 56}
          />
        )}
        meta={
          <>
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
          </>
        }
      />

      {/* Tabs — URL-driven (?tab=), like the Users & Roles panel. */}
      <div className="flex shrink-0 gap-1 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
        {visibleTabs.map((t) => {
          const hit = tabAttention(t.attention);
          return (
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
              {/* On the selected tab the tone colours would sit on the accent fill and read as a
                  separate control; an inherited-colour number is enough once you are looking at it. */}
              {activeTab === t.id ? (
                hit.count > 0 ? <span className="tabular-nums opacity-80">{hit.count}</span> : null
              ) : (
                <CountPill count={hit.count} tone={hit.tone} label={`awaiting action on ${t.label}`} />
              )}
            </button>
          );
        })}
      </div>

      {/* Tabs that lay themselves out full-height (flex h-full → their own inner scroller) get a
          BOUNDED box and no scrollbar of their own here; a second one would let the whole tab
          scroll inside this box while its list scrolled inside that, giving two nested scrollbars
          for one list. Card-style tabs keep scrolling as a page. Same split as WarehouseDetail's
          `fill` flag — kept as a list rather than a tab-config field because only these two need it. */}
      <div
        className={`min-h-0 flex-1 ${
          activeTab === "catalogue" || activeTab === "submissions" ? "overflow-hidden" : "overflow-auto"
        }`}
      >
        {activeTab === "overview" && <OverviewTab customer={customer} />}
        {activeTab === "projects" && (
          <ProjectsSection customer={customer} caps={projectCaps} onChange={setCustomer} pushToast={pushToast} />
        )}
        {activeTab === "catalogue" && (
          <StockEntriesTab
            customer={customer}
            stockCaps={stockCaps}
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
      </div>

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
      <div className="flex items-center gap-1.5 wrap-break-word text-sm text-[var(--ink)]">{children}</div>
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
function ProjectsSection({ customer, caps, pushToast }: SectionProps) {
  const canWrite = caps.edit || caps.delete;
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CustomerProject | null>(null);

  // Server-paged — the detail payload no longer carries the child sets, so this tab owns its
  // own paged fetch (same local-state pattern as the Inventory tab below).
  const [paged, setPaged] = React.useState<customerService.PagedCustomerProjects | null>(null);
  const [page, setPage] = React.useState(1);
  const [refreshKey, setRefreshKey] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    customerService
      .listCustomerProjects(customer.id, { page, pageSize: 20 })
      .then((r) => { if (active) setPaged(r); })
      .catch((err) => { if (active) pushToast(err instanceof Error ? err.message : "Could not load projects.", "alert"); });
    return () => { active = false; };
  }, [customer.id, page, refreshKey, pushToast]);
  const reload = () => setRefreshKey((k) => k + 1);
  const projects = paged?.projects ?? [];

  const onSaved = () => {
    reload();
    setOpen(false);
    setEditing(null);
  };

  const remove = async (project: CustomerProject) => {
    try {
      await customerService.deleteProject(customer.id, project.id);
      reload();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not remove project.", "alert");
    }
  };

  return (
    <FormSection
      title="Projects"
      description="The customer's projects (used when creating jobs)."
      action={
        caps.create && (
          <button type="button" onClick={() => { setEditing(null); setOpen(true); }} className={primaryBtn}>
            <Plus className="h-4 w-4" /> Add project
          </button>
        )
      }
    >
      {paged === null ? (
        <TableShellSkeleton head={["Code", "Project", "Dates", "Status", canWrite ? "" : null]} />
      ) : projects.length === 0 ? (
        <Empty>No projects yet.</Empty>
      ) : (
        <>
        <TableShell head={["Code", "Project", "Dates", "Status", canWrite ? "" : null]}>
          {projects.map((project) => (
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
        {(paged?.totalPages ?? 1) > 1 && (
          <div className="mt-3">
            <Pagination page={paged?.page ?? 1} totalPages={paged?.totalPages ?? 1} total={paged?.total ?? 0} label="projects" onPage={setPage} />
          </div>
        )}
        </>
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
const STOCK_PAGE_SIZE = 20;
const SUBMISSION_PAGE_SIZE = 20;

function StockEntriesTab({
  customer,
  stockCaps,
  router,
}: {
  customer: Customer;
  stockCaps: SectionCaps;
  router: ReturnType<typeof useRouter>;
}) {
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  // goods_management.view gates the damaged-stock section — this is the same permission
  // that controls the broader Goods Management feature access (warehouse damaged tab,
  // overdue view, etc.), so it is the correct gate here. The warehouse pill on stock
  // entries uses inventory.view, which is a separate concern.
  const canViewDamaged = can("goods_management.view");

  // --- URL-persisted status filter ("stock_filter") --------------------------
  const searchParams = useSearchParams();
  const stockFilter = (searchParams.get("stock_filter") ?? "") as "" | "active" | "draft";
  // Text search, matched in memory against the already-loaded list (same helper the warehouse's
  // Customer-pool table uses, so both agree on what a match means). URL-persisted like the filter.
  const stockSearch = searchParams.get("stock_q") ?? "";

  const patch = React.useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  // --- URL-persisted sub-tab pool filter ("pool") ----------------------------
  const requestedPool = searchParams.get("pool");
  const activePool: "usable" | "damaged" =
    canViewDamaged && requestedPool === "damaged" ? "damaged" : "usable";

  const setPool = (p: "usable" | "damaged") => {
    patch({ pool: p === "usable" ? "" : "damaged" });
  };

  // --- URL-persisted stock page ("stockPage") ----------------------------
  const page = Math.max(1, Number(searchParams.get("stockPage")) || 1);
  const patchPage = React.useCallback(
    (next: number | null) => {
      const params = new URLSearchParams(window.location.search);
      if (next && next > 1) params.set("stockPage", String(next)); else params.delete("stockPage");
      router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  // --- stock entries list (service returns a plain array — paginate client-side) ---
  const [entries, setEntries] = React.useState<CustomerStockEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    customerService
      .listCustomerStockEntries(customer.id, stockFilter || undefined)
      .then((rows) => { setEntries(rows); })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load stock entries."));
  }, [customer.id, stockFilter]);

  React.useEffect(() => { load(); }, [load]);

  /**
   * Remove a stock entry that never held anything, or no longer does.
   *
   * `customer_stock.delete` has existed end to end since the module was written — route, permission,
   * dependency checks, audit — and the two sibling sections in this same file both offer it. Only the
   * stock table never grew the button, so a role could hold the key with nothing to use it on.
   *
   * The server decides. It refuses an entry still holding units, and refuses one anything else points
   * at, with a sentence naming which — so a failure here is worth showing verbatim rather than
   * flattening into "Delete failed".
   */
  const removeEntry = async (entry: CustomerStockEntry) => {
    try {
      await customerService.deleteStockEntry(entry.id);
      pushToast(`"${entry.itemName}" removed.`, "success");
      load();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not remove that entry.", "alert");
    }
  };

  // Memoised derived values — client-side slice for the current page + totals.
  // Wrapping in useMemo prevents React Compiler from bailing on
  // "Existing memoization could not be preserved".
  const { pageEntries, entryCount, totalPages } = React.useMemo(() => {
    const all = searchStockEntries(entries ?? [], stockSearch);
    const count = all.length;
    const pages = Math.max(1, Math.ceil(count / STOCK_PAGE_SIZE));
    const safePage = Math.min(page, pages);
    const start = (safePage - 1) * STOCK_PAGE_SIZE;
    return {
      pageEntries: all.slice(start, start + STOCK_PAGE_SIZE),
      entryCount: count,
      totalPages: pages,
    };
  }, [entries, page, stockSearch]);

  return (
    <div className="stack flex h-full flex-col">
      {canViewDamaged && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {([
            { key: "usable", label: "Usable stock" },
            { key: "damaged", label: "Damaged stock" },
          ] as const).map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPool(p.key)}
              className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition-all ${
                activePool === p.key
                  ? "bg-[var(--accent)] text-white shadow-xs"
                  : "border border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {activePool === "usable" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {/* Stock entries table */}
          {error ? (
            <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
          ) : entries === null ? (
            /* Skeleton — mirrors the loaded table layout. Uses the shared <Skeleton>, not raw
               `animate-pulse` divs: that shimmers where this pulsed, so the same page showed two
               different loading animations depending on which tab you opened. */
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="border-b border-[var(--border)] px-4 py-3 shrink-0">
                <Skeleton className="h-4 w-32" />
              </div>
              <div className="divide-y divide-[var(--border)] min-h-0 flex-1 overflow-auto">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-4 px-4 py-3">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-10" />
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="ml-auto h-6 w-16 rounded-full" />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <div className="relative w-full sm:max-w-[16rem]">
                  <SearchIcon className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
                  <input
                    value={stockSearch}
                    onChange={(e) => patch({ stock_q: e.target.value, stockPage: "" })}
                    placeholder="Search item, SKU, barcode…"
                    aria-label="Search stock entries"
                    className={`${toolbarInputCls} pl-9`}
                  />
                </div>
                <Select
                  size="sm"
                  value={stockFilter}
                  onChange={(v) => patch({ stock_filter: v, stockPage: "" })}
                  options={[
                    { value: "", label: "All" },
                    { value: "active", label: "Active" },
                    { value: "draft", label: "Draft" },
                  ]}
                  ariaLabel="Filter by status"
                />
                <span className="ml-1 text-xs text-[var(--muted)]">
                  {entryCount} {entryCount === 1 ? "entry" : "entries"}
                </span>
                {/* The status filter goes to the server; the search box filters the loaded rows in
                    memory (searchStockEntries above), so it is NOT sent — the export is "every entry
                    matching the STATUS I picked", which is what the count beside it means too. */}
                <ExportButton
                  onExport={() => customerService.exportCustomerStockCsv(customer.id, { status: stockFilter || undefined })}
                  disabled={entryCount === 0}
                  title="Export this customer's stock to CSV"
                />
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

              {/* Keyed off the FILTERED count, not the raw list: a search that matches nothing used
                  to fall through and render a table with no rows in it. The copy separates "there
                  is nothing here" from "your search hides it" so the latter never reads as the
                  former. */}
              {entryCount === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
                  <Boxes className="h-7 w-7 text-[var(--faint)]" />
                  <p className="text-sm font-semibold text-[var(--ink)]">No stock entries</p>
                  <p className="text-xs text-[var(--muted)]">
                    {stockSearch.trim()
                      ? `Nothing matches “${stockSearch.trim()}”${stockFilter ? ` in ${stockFilter} entries` : ""}.`
                      : stockFilter
                        ? `No ${stockFilter} entries found.`
                        : "Received stock for this customer will appear here."}
                  </p>
                  {(stockSearch.trim() || stockFilter) && (
                    <button
                      type="button"
                      onClick={() => patch({ stock_q: "", stock_filter: "", stockPage: "" })}
                      className={`${secondaryBtn} mt-1`}
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
                    <div className="min-h-0 flex-1 overflow-auto">
                      <table className="w-full text-left text-sm" style={{ minWidth: 750 }}>
                        <thead className="sticky top-0 z-10 bg-[var(--surface)] shadow-[0_1px_0_0_var(--border)]">
                          <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)] bg-[var(--surface)]">
                            <th className="cell-y px-4">Item</th>
                            <th className="cell-y px-4">Warehouse</th>
                            <th className="cell-y px-4">SKU</th>
                            <th className="cell-y px-4">Qty</th>
                            <th className="cell-y px-4">Barcode</th>
                            <th className="cell-y px-4">Status</th>
                            <th className="cell-y px-4">Received</th>
                            <th className="cell-y px-4" />
                          </tr>
                        </thead>
                        <tbody>
                          {pageEntries.map((e) => (
                            <tr
                              key={e.id}
                              className="cursor-pointer border-b border-[var(--border)] align-top transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                              onClick={() => router.push(`/dashboard/stock-entries/${e.id}?from=customer`)}
                            >
                              <td className="cell-y px-4 font-semibold text-[var(--ink)]">{e.itemName}</td>
                              <td className="cell-y px-4">
                                <div className="text-[var(--ink)]">{e.warehouseName}</div>
                                <div className="font-mono text-[11px] text-[var(--faint)]">{e.warehouseCode}</div>
                              </td>
                              <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{e.sku ?? "—"}</td>
                              <td className="cell-y px-4 font-bold text-[var(--ink)]">{e.quantity}</td>
                              <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{e.barcode ?? "—"}</td>
                              <td className="cell-y px-4">
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
                              <td className="cell-y px-4 text-xs text-[var(--muted)]">{fmtDate(e.receivedAt ?? e.createdAt)}</td>
                              <td className="cell-y px-4">
                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    title="View"
                                    onClick={(ev) => { ev.stopPropagation(); router.push(`/dashboard/stock-entries/${e.id}?from=customer`); }}
                                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)]"
                                  >
                                    <Eye className="h-4 w-4" />
                                  </button>
                                  {/* `stopPropagation` because the ROW navigates: without it, opening
                                      the confirm also pushed the detail page underneath it, and the
                                      dialog was answered on a screen the user had not asked for. */}
                                  {stockCaps.delete && (
                                    <span onClick={(ev) => ev.stopPropagation()}>
                                      <DeleteConfirmButton
                                        label={e.itemName}
                                        onConfirm={() => removeEntry(e)}
                                        disabledReason={
                                          e.quantity > 0
                                            ? `${e.quantity} unit${e.quantity === 1 ? "" : "s"} still in stock — move or dispatch the stock before deleting the entry.`
                                            : undefined
                                        }
                                      />
                                    </span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="shrink-0">
                    <Pagination
                      page={Math.min(page, totalPages)}
                      totalPages={totalPages}
                      total={entryCount}
                      label="entries"
                      onPage={(n) => patchPage(n)}
                    />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <DamagedStockView customerId={customer.id} fill />
        </div>
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

  // Search / status / page. Submissions accumulate for the life of the account and this is the only
  // admin-side surface for reviewing them, so the whole list was previously rendered at once.
  const [filters, setFilters] = React.useState<SubmissionFilters>(DEFAULT_SUBMISSION_FILTERS);
  const [page, setPage] = React.useState(1);
  const patchFilters = (next: Partial<SubmissionFilters>) => {
    setFilters((prev) => ({ ...prev, ...next }));
    setPage(1); // a narrower list makes the old page number meaningless
  };

  const allSubmissions = customer.stockRequests;
  const statusOptions = React.useMemo(() => submissionStatusOptions(allSubmissions), [allSubmissions]);
  // A status whose last row was just approved away would otherwise strand the tab on an empty list.
  const effective = React.useMemo(
    () => effectiveSubmissionFilters(filters, statusOptions),
    [filters, statusOptions],
  );
  const matched = React.useMemo(
    () => filterSubmissions(allSubmissions, effective),
    [allSubmissions, effective],
  );
  const totalPages = Math.max(1, Math.ceil(matched.length / SUBMISSION_PAGE_SIZE));
  // Clamped, not stored: approving the last row on the last page shrinks the list under the cursor.
  const safePage = Math.min(page, totalPages);
  const pageRows = matched.slice((safePage - 1) * SUBMISSION_PAGE_SIZE, safePage * SUBMISSION_PAGE_SIZE);
  const anyFilter = hasActiveSubmissionFilter(effective);

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
    // Full-height inline scroll, like the Inventory tab next door: the toolbar and the list's own
    // header stay put and ONLY the rows scroll. As a plain `space-y-6` block the whole tab scrolled
    // inside the shell's viewport, so on a laptop the visible window onto the list was a few rows
    // tall — with the search box and the paginator both scrolled out of reach of the rows they
    // control. Submissions accumulate for the life of the account, so this is the tab that needs it.
    <div className="stack flex h-full flex-col">
      {/* ONE toolbar row: filters left, the create action right. They used to be two rows, which
          left a band of dead space beside the filters. `ml-auto` on the button parks it at the
          right edge whether or not the filters are there — so the empty-list case (button only)
          still lines up without a second rule. */}
      {(stockReq.approve || allSubmissions.length > 0) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {allSubmissions.length > 0 && (
            <>
              <div className="relative w-full sm:max-w-[16rem]">
                <SearchIcon className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
                <input
                  value={filters.search}
                  onChange={(e) => patchFilters({ search: e.target.value })}
                  placeholder="Search submissions…"
                  aria-label="Search stock submissions"
                  className={`${toolbarInputCls} pl-9`}
                />
              </div>
              {/* `effective`, so a status whose rows are gone reads as "All" instead of blank. */}
              <Select
                size="sm"
                value={effective.status}
                onChange={(v) => patchFilters({ status: v })}
                options={statusOptions}
                ariaLabel="Filter submissions by status"
              />
              {anyFilter && (
                <button
                  type="button"
                  onClick={() => { setFilters(DEFAULT_SUBMISSION_FILTERS); setPage(1); }}
                  className={toolbarBtn}
                >
                  Clear
                </button>
              )}
            </>
          )}
          {stockReq.approve && (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className={`${primaryBtn} ml-auto`}
            >
              <Plus className="h-4 w-4" /> New submission
            </button>
          )}
        </div>
      )}

      {matched.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
          <ClipboardList className="h-7 w-7 text-[var(--faint)]" />
          {/* THREE cases, not two. The default view is "Open", so an empty table can also mean
              "nothing outstanding, but there IS history" — saying "No stock submissions" there
              would flatly contradict the finished ones sitting one filter away. */}
          <p className="text-sm font-semibold text-[var(--ink)]">
            {anyFilter ? "No matching submissions" : allSubmissions.length > 0 ? "Nothing outstanding" : "No stock submissions"}
          </p>
          <p className="text-xs text-[var(--muted)]">
            {anyFilter
              ? `${allSubmissions.length} submission${allSubmissions.length === 1 ? "" : "s"} here, none match these filters.`
              : allSubmissions.length > 0
                ? `All ${allSubmissions.length} submission${allSubmissions.length === 1 ? " is" : "s are"} finished — switch to “All statuses” to review them.`
                : "Stock the customer submits from their portal — or that you add on their behalf — appears here for review."}
          </p>
          {anyFilter ? (
            <button
              type="button"
              onClick={() => { setFilters(DEFAULT_SUBMISSION_FILTERS); setPage(1); }}
              className={`${secondaryBtn} mt-1`}
            >
              Clear filters
            </button>
          ) : (
            allSubmissions.length > 0 && (
              // One click to the history rather than making the user find the menu.
              <button
                type="button"
                onClick={() => { patchFilters({ status: ALL_SUBMISSION_STATUSES }); }}
                className={`${secondaryBtn} mt-1`}
              >
                Show all submissions
              </button>
            )
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">
            <ClipboardList className="h-3.5 w-3.5" />
            Stock submissions ({matched.length}{anyFilter ? ` of ${allSubmissions.length}` : ""})
          </div>
          {/* The ONLY scroller in the tab. */}
          <div className="min-h-0 flex-1 divide-y divide-[var(--border)] overflow-auto">
            {/* No row tint. An earlier pass amber-washed the actionable rows, and it was wrong twice:
                the row already announces itself (one carrying "Approve as-is" or "Assign warehouses"
                is self-evidently outstanding), and in the default Open view — actionable rows plus
                receiving-in-progress ones — the wash routinely covered most of the list, at which
                point the UNMARKED row becomes the signal. "Which ones need me" is answered by the
                "Needs you (N)" filter, which is the tab's own number made clickable. */}
            {pageRows.map((req) => (
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
                      {req.linkedStockEntryId && <TopUpBadge />}
                    </div>
                    {/* Shown ONLY when we actually know who asked. The fallback used to read
                        "requested by a portal user", which was wrong for the commonest case that
                        lacks a name: a submission an admin raised on the customer's behalf, where
                        the contact field is optional and often left blank. That attributed the
                        request to a portal user who never made it — and on a provenance line, an
                        invented attribution is worse than no line at all. */}
                    {req.requestedByName && (
                      <div className="mt-0.5 text-[11px] text-[var(--faint)]">
                        requested by {req.requestedByName}
                      </div>
                    )}
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
                      // Column, not a `justify-between` row: the closure note below is a second
                      // child, and as a flex ROW sibling it sat squeezed to the right of the
                      // warehouse line instead of under it (with an `mt-1` that a row ignores).
                      <div
                        key={a.id}
                        className="rounded-lg bg-[var(--surface-2)] px-2.5 py-1.5 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-[var(--ink)]">{a.warehouseName}</span>
                          {a.warehouseCode && (
                            <span className="font-mono text-[var(--faint)]">{a.warehouseCode}</span>
                          )}
                          <span className="text-[var(--muted)]">
                            {a.receivedQuantity}/{a.quantity} received
                          </span>
                          <AssignmentStatusBadge status={a.status} />
                        </div>
                        {/* The badge says the delivery was closed with stock outstanding, and the
                            ratio above says what landed — but neither states the SHORTFALL, which
                            is the figure a query about this line will be about. Spelled out rather
                            than left as a subtraction across two numbers. The reason follows it:
                            the number raises the question, the reason is the answer. */}
                        {a.status === "closed_short" && a.quantity - a.receivedQuantity > 0 && (
                          <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
                            {/* Same phrase the customer's own portal uses, so a call about this line
                                has both sides reading the identical words off their screens. */}
                            <span className="font-bold text-[var(--warn)]">
                              {a.quantity - a.receivedQuantity} not received
                            </span>
                            {a.closureReason && <> — {a.closureReason}</>}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          {totalPages > 1 && (
            // Pinned below the scroller, not trailing the last row — the control that changes the
            // page shouldn't require paging through the rows to reach it.
            <div className="shrink-0 border-t border-[var(--border)] px-3 py-2">
              <Pagination
                page={safePage}
                totalPages={totalPages}
                total={matched.length}
                label="submissions"
                onPage={setPage}
              />
            </div>
          )}
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
function SitesSection({ customer, caps, pushToast }: SectionProps) {
  const canWrite = caps.edit || caps.delete;
  const [open, setOpen] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [editing, setEditing] = React.useState<CustomerSite | null>(null);

  // Server-paged with search — sites can be bulk-imported in the THOUSANDS, so this tab never
  // loads the full set (the detail payload no longer carries it either).
  const [paged, setPaged] = React.useState<customerService.PagedCustomerSites | null>(null);
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const [searchInput, setSearchInput] = React.useState("");
  const [refreshKey, setRefreshKey] = React.useState(0);
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== search) {
        setSearch(searchInput.trim());
        setPage(1);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search]);
  React.useEffect(() => {
    let active = true;
    customerService
      .listCustomerSites(customer.id, { q: search || undefined, page, pageSize: 20 })
      .then((r) => { if (active) setPaged(r); })
      .catch((err) => { if (active) pushToast(err instanceof Error ? err.message : "Could not load sites.", "alert"); });
    return () => { active = false; };
  }, [customer.id, search, page, refreshKey, pushToast]);
  const reload = () => setRefreshKey((k) => k + 1);
  const sites = paged?.sites ?? [];

  const onSaved = () => {
    reload();
    setOpen(false);
    setEditing(null);
  };

  // Refresh the paged list, but keep the modal open on its result step (the modal's own "Done"
  // button closes it). Closing here would unmount the result screen.
  const onImported = (created: CustomerSite[]) => {
    if (created.length) reload();
  };

  const remove = async (site: CustomerSite) => {
    try {
      await customerService.deleteSite(customer.id, site.id);
      reload();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not remove site.", "alert");
    }
  };

  return (
    <FormSection
      title="Sites"
      description="Delivery / installation locations."
      action={
        caps.create && (
          <>
            <button type="button" onClick={() => setImporting(true)} className={secondaryBtn}>
              <Upload className="h-4 w-4" /> Import sites
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
              className={primaryBtn}
            >
              <Plus className="h-4 w-4" /> Add site
            </button>
          </>
        )
      }
    >
      {/* Search — server-side (a bulk-imported customer can have thousands of sites). */}
      <div className="relative mb-3 w-full sm:max-w-xs">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search name, code or postcode…"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
        />
      </div>

      {paged === null ? (
        <TableShellSkeleton head={["Code", "Site", "Postcode", "Contact", "Status", canWrite ? "" : null]} />
      ) : sites.length === 0 ? (
        <Empty>{search ? "No matching sites." : "No sites yet."}</Empty>
      ) : (
        <>
        <TableShell head={["Code", "Site", "Postcode", "Contact", "Status", canWrite ? "" : null]}>
          {sites.map((site) => (
            <tr key={site.id} className="border-b border-[var(--border)] align-top last:border-0">
              <td className="px-3 py-2 font-mono text-xs text-[var(--muted)]">{site.code ?? "—"}</td>
              <td className="px-3 py-2">
                <div className="font-semibold text-[var(--ink)]">{site.name}</div>
                {(() => {
                  const line = [site.addressLine1, site.addressLine2, site.city, site.county].filter(Boolean).join(", ");
                  return line ? <div className="text-[11px] text-[var(--muted)]">{line}</div> : null;
                })()}
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
        {(paged?.totalPages ?? 1) > 1 && (
          <div className="mt-3">
            <Pagination page={paged?.page ?? 1} totalPages={paged?.totalPages ?? 1} total={paged?.total ?? 0} label="sites" onPage={setPage} />
          </div>
        )}
        </>
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

      {importing && (
        <SiteImportModal
          customerId={customer.id}
          onClose={() => setImporting(false)}
          onImported={onImported}
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

// First-load placeholder for a TableShell. Takes the SAME `head` the real table will render, so the
// column count and the header row are already correct when the rows arrive and nothing jumps.
//
// Replaces the "Loading projects…" / "Loading sites…" one-liners these sections used to show. A line
// of text is a different SHAPE from the table that follows it, so the card visibly resized on every
// load — and it read as an empty state ("No projects yet." renders in exactly the same place, same
// size, same colour) right up until the rows appeared. Skeletons are what the rest of the dashboard
// uses for a first load; these two were the last list surfaces that didn't.
function TableShellSkeleton({ head, rows = 3 }: { head: (string | null)[]; rows?: number }) {
  const cols = head.filter((h) => h !== null).length;
  // Varied widths per column so it reads as a table of content rather than a block of grey bars.
  const widths = ["w-16", "w-40", "w-32", "w-14", "w-10"];
  return (
    <TableShell head={head}>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-b border-[var(--border)] last:border-0">
          {Array.from({ length: cols }).map((_c, i) => (
            <td key={i} className="px-3 py-2">
              <Skeleton className={`h-4 ${widths[i % widths.length]}`} />
            </td>
          ))}
        </tr>
      ))}
    </TableShell>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-[var(--muted)]">{children}</p>;
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

// Every status keeps its own hue — the colour says WHICH state, not how urgent it is.
const REQ_STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-600",
  approved: "bg-[var(--pos)]/12 text-[var(--pos)]",
  rejected: "bg-[var(--neg)]/12 text-[var(--neg)]",
  assigned: "bg-blue-500/12 text-blue-600",
  partially_received: "bg-indigo-500/12 text-indigo-600",
  completed: "bg-[var(--accent-10)] text-[var(--accent)]",
};

/**
 * Weight, not colour, marks a status the tab still owes something on.
 *
 * The row already announces itself through its buttons, and the earlier attempt at an amber row wash
 * covered most of the default view — so the signal lives on the STATUS instead, which is the
 * GitHub/Linear/Jira convention: the chip carries the meaning, the row stays quiet. A ring plus a
 * ring-offset reads as "raised" at 10px without adding a sixth colour to a row that already has
 * three buttons in it.
 */
function RequestStatusBadge({ status }: { status: string }) {
  const actionable = isActionable({ name: "", editedName: null, status });
  return (
    <span
      title={actionable ? "Waiting on you" : undefined}
      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${REQ_STATUS_COLORS[status] ?? REQ_STATUS_COLORS.pending} ${
        actionable ? "ring-1 ring-current/40 ring-offset-1 ring-offset-[var(--surface)]" : ""
      }`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

// Marks a submission that tops up an existing stock line (vs. a brand-new item) — its
// received quantity is added onto that line rather than creating a duplicate.
function TopUpBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-10)] px-2 py-0.5 text-[10px] font-bold text-[var(--accent)]">
      <PackagePlus className="h-3 w-3" />
      Top-up
    </span>
  );
}

const ASSIGN_STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-600",
  partially_received: "bg-indigo-500/12 text-indigo-600",
  received: "bg-[var(--pos)]/12 text-[var(--pos)]",
  // Terminal but NOT a success — muted rather than green. Without an entry here it fell through to
  // the `pending` amber, which read as "still waiting" for a delivery that had already been closed.
  closed_short: "bg-[var(--surface-2)] text-[var(--muted)]",
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
  /**
   * Why this cannot be deleted right now — rendered as the button's tooltip, and its presence is what
   * disables it.
   *
   * The alternative was to hide the button on the rows that would be refused. In a table that makes
   * the control column flicker between rows and leaves the reader to work out the rule from which
   * rows have a trash icon; disabled with the reason on it states the rule instead. The server checks
   * it again either way — this only stops the click that could only ever fail.
   */
  disabledReason,
}: {
  label: string;
  onConfirm: () => Promise<void>;
  disabledReason?: string;
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
        disabled={Boolean(disabledReason)}
        title={disabledReason}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--faint)] transition-colors hover:bg-[var(--neg)]/10 hover:text-[var(--neg)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--faint)]"
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

