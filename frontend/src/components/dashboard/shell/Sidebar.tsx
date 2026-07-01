"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Building2,
  Package,
  ScrollText,
  Settings,
  UserCog,
  UserRound,
  X,
  ChevronDown,
  LogOut,
  LayoutDashboard,
  FolderKanban,
  MapPin,
  ClipboardList,
  BarChart3,
  Warehouse,
  Truck,
  PackageCheck,
  Boxes,
  ArrowRightLeft,
} from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useBranding } from "@/hooks/useBranding";
import { useNavigationGuard } from "@/providers/NavigationGuardProvider";
import { BrandMark } from "@/components/branding/BrandMark";
import { optimizeCloudinaryUrl } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  icon: React.ElementType;
  // Visible if the principal holds ANY of these permissions (admin holds all).
  perms: string[];
};

const NAV: NavItem[] = [
  { href: "/dashboard/users", label: "Users & Roles", icon: UserCog, perms: ["users.view", "roles.view"] },
  { href: "/dashboard/customers", label: "Customers", icon: Building2, perms: ["customers.view"] },
  { href: "/dashboard/jobs", label: "Jobs", icon: ClipboardList, perms: ["jobs.view"] },
  { href: "/dashboard/warehouses", label: "Warehouses", icon: Warehouse, perms: ["warehouse.view"] },
  { href: "/dashboard/suppliers", label: "Suppliers", icon: Truck, perms: ["suppliers.view"] },
  // IRM Catalogue now lives inside Inventory (IRM tab → Catalogue); standalone nav removed.
  { href: "/dashboard/purchase-orders", label: "Purchase Orders", icon: ClipboardList, perms: ["purchase_orders.view"] },
  { href: "/dashboard/goods-in", label: "GRN", icon: PackageCheck, perms: ["goods_in.view"] },
  { href: "/dashboard/inventory", label: "Inventory", icon: Boxes, perms: ["inventory.view"] },
  {
    // Only the perms that map to a real Settings section (see SettingsPanel). Master-data view perms
    // (warehouse/supplier/IRM types + IRM categories) belong to their own modules' tabs, so they must
    // NOT surface Settings here — otherwise the user opens an empty Settings page.
    href: "/dashboard/settings",
    label: "Settings",
    icon: Settings,
    perms: ["settings.view", "email_templates.view", "categories.view"],
  },
  {
    href: "/dashboard/audit",
    label: "Audit Log",
    icon: ScrollText,
    perms: ["audit.view"],
  },
];

// The customer portal nav — a separate, read-only surface (no staff permissions).
// Everything is view-only except Stock Submissions (the one place a customer writes).
// Settings reuses the shared account page (profile + password).
const CUSTOMER_NAV: NavItem[] = [
  { href: "/dashboard/portal", label: "Dashboard", icon: LayoutDashboard, perms: [] },
  { href: "/dashboard/portal/projects", label: "Projects", icon: FolderKanban, perms: [] },
  { href: "/dashboard/portal/sites", label: "Sites", icon: MapPin, perms: [] },
  { href: "/dashboard/stock", label: "My Stock", icon: Package, perms: [] },
  { href: "/dashboard/portal/requests", label: "Stock Submissions", icon: ClipboardList, perms: [] },
  { href: "/dashboard/portal/reports", label: "Reports", icon: BarChart3, perms: [] },
  { href: "/dashboard/account", label: "Settings", icon: Settings, perms: [] },
];

// The engineer portal nav — a separate, isolated surface for staff field engineers, exactly like the
// customer portal above. Shown ONLY when the engineer portal is the user's only surface (see
// `isEngineer` below) — it is NEVER mixed into the admin nav.
const ENGINEER_NAV: NavItem[] = [
  { href: "/dashboard/engineer", label: "Dashboard", icon: LayoutDashboard, perms: ["engineer.dashboard.view"] },
  { href: "/dashboard/engineer/jobs", label: "Jobs", icon: ClipboardList, perms: ["engineer.jobs.view"] },
  { href: "/dashboard/engineer/inventory", label: "Stock", icon: Boxes, perms: ["engineer.inventory.view"] },
  { href: "/dashboard/engineer/transfers", label: "Transfers", icon: ArrowRightLeft, perms: ["engineer.transfer"] },
  { href: "/dashboard/account", label: "Settings", icon: Settings, perms: [] },
];

export function Sidebar({
  collapsed,
  mobileOpen,
  onCloseMobile,
}: {
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const { principal, can, logout } = useAuth();
  const { brandName } = useBranding();
  const router = useRouter();
  const pathname = usePathname();
  const guard = useNavigationGuard();
  const [showProfileDropdown, setShowProfileDropdown] = React.useState(false);

  const handleSignOut = async () => {
    await logout();
    router.replace("/login");
  };

  const isCustomer = principal?.type === "customer";

  // Staff admin nav, permission-filtered. Warehouse-scoped roles (e.g. Warehouse Manager) do their
  // receiving inside their Warehouse Detail page (the primary GRN workspace), so by default the GLOBAL
  // "GRN" entry is hidden for them (Option A). The module + routes stay reachable and the global list is
  // already auto-scoped server-side — flip HIDE_GLOBAL_GRN_FOR_SCOPED to false to show it (Option B).
  const HIDE_GLOBAL_GRN_FOR_SCOPED = true;
  const isWarehouseScoped = principal?.type === "user" && principal.isWarehouseScoped === true;
  const adminNav = NAV.filter((item) => {
    if (!item.perms.some((p) => can(p))) return false;
    if (HIDE_GLOBAL_GRN_FOR_SCOPED && isWarehouseScoped && item.href === "/dashboard/goods-in") return false;
    return true;
  });

  // Engineer-portal access is for STAFF users (principal.type === "user") who hold the engineer
  // dashboard permission. Keyed on the user type (not on adminNav being empty) so a mixed-role staff
  // member — engineer permission PLUS some admin sections — sees BOTH groups instead of losing the
  // engineer nav. The super-admin (a different principal type) is intentionally excluded, even though
  // its "*" technically grants engineer.* — its surface stays the Admin Suite.
  const canEngineer = principal?.type === "user" && can("engineer.dashboard.view");
  const isEngineerOnly = canEngineer && adminNav.length === 0;

  // Engineer items shown alongside the admin menu drop the shared account "Settings" link (admins
  // reach their account via the profile menu) to avoid a duplicate Settings entry. A pure engineer
  // keeps the full portal nav, exactly as before.
  const engineerNav = ENGINEER_NAV.filter(
    (i) =>
      (i.perms.length === 0 || i.perms.some((p) => can(p))) &&
      (isEngineerOnly || i.href !== "/dashboard/account"),
  );

  // Nav groups. Customers get a single surface; staff get the admin menu and/or the engineer portal.
  type NavGroup = { key: string; label: string; items: NavItem[] };
  const navGroups: NavGroup[] = isCustomer
    ? [{ key: "menu", label: "Menu", items: CUSTOMER_NAV }]
    : [
        ...(adminNav.length > 0 ? [{ key: "menu", label: "Menu", items: adminNav }] : []),
        ...(canEngineer ? [{ key: "engineer", label: "Engineer Portal", items: engineerNav }] : []),
      ];

  // Profile chip — super-admin, staff user, or customer.
  const isUser = principal?.type === "user";
  const initials =
    principal?.type === "user"
      ? `${principal.firstName[0] ?? ""}${principal.lastName[0] ?? ""}`.toUpperCase() || "U"
      : principal?.type === "customer"
        ? (principal.name.trim()[0] ?? "C").toUpperCase()
        : "SA";
  const displayName =
    principal?.type === "user"
      ? `${principal.firstName} ${principal.lastName}`.trim() || principal.email
      : principal?.type === "customer"
        ? principal.name
        : principal?.name || principal?.email || "Super Admin";
  const roleLabel =
    principal?.type === "user"
      ? principal.role?.name ?? "Staff"
      : principal?.type === "customer"
        ? "Customer"
        : "Super Admin";
  const avatarUrl =
    principal?.type === "user"
      ? principal.profileImageUrl
      : principal?.type === "customer"
        ? principal.logoUrl
        : null;

  const renderNav = (items: NavItem[]) =>
    items.map((item) => {
      const Icon = item.icon;
      const active = pathname === item.href;
      return (
        <Link
          key={item.href}
          href={item.href}
          onNavigate={(e) => {
            // Don't lose unsaved edits when navigating to another page.
            if (active || !guard.anyDirty()) return;
            e.preventDefault();
            guard.attemptLeave(() => router.push(item.href));
          }}
          onClick={onCloseMobile}
          title={collapsed ? item.label : undefined}
          className={`w-full flex items-center border-l-4 border-transparent rounded-xl text-xs font-bold transition-all duration-300 cursor-pointer text-left
            ${collapsed ? "justify-center p-2.5 gap-0" : "px-3.5 py-2.5 gap-3"}
            ${
              active
                ? "bg-[var(--accent-10)] text-[var(--accent)] font-extrabold border-l-[var(--accent)]"
                : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
            }`}
        >
          <div className="flex-shrink-0">
            <Icon className="w-4 h-4" />
          </div>
          <span
            className={`transition-all duration-300 text-left overflow-hidden whitespace-nowrap ${
              collapsed
                ? "w-0 opacity-0 pointer-events-none"
                : "w-full opacity-100 ml-0.5 flex-1 truncate"
            }`}
          >
            {item.label}
          </span>
        </Link>
      );
    });

  return (
    <aside
      className={`fixed md:sticky top-0 left-0 h-screen bg-[var(--surface)] border-r border-[var(--border)] transition-all duration-300 z-40 flex flex-col justify-between py-6 shrink-0
        ${collapsed ? "w-20 px-3" : "w-64 px-4"}
        ${mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}
    >
      <div className="space-y-6">
        {/* Brand */}
        <div
          className={`flex items-center transition-all duration-300 gap-3 ${
            collapsed ? "px-1 justify-center" : "px-2"
          }`}
        >
          <BrandMark className="w-9 h-9 rounded-xl text-lg shadow-md accent-glow select-none" />
          <div
            className={`leading-none transition-all duration-300 overflow-hidden whitespace-nowrap ${
              collapsed ? "w-0 opacity-0 pointer-events-none" : "w-32 opacity-100"
            }`}
          >
            <h2 className="font-extrabold text-base tracking-tight text-[var(--ink)]">
              {brandName}
            </h2>
            <span className="text-[10px] uppercase font-bold tracking-widest text-[var(--faint)] mt-0.5 block">
              {isCustomer ? "Customer Portal" : isEngineerOnly ? "Engineer Portal" : "Admin Suite"}
            </span>
          </div>
          <button
            onClick={onCloseMobile}
            className="md:hidden ml-auto p-1 border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--muted)] rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Nav — one labelled group per surface (admin menu and/or engineer portal). */}
        {navGroups.length > 0 && (
          <div className="space-y-5">
            {navGroups.map((group) => (
              <div key={group.key}>
                <span
                  className={`text-[10px] font-extrabold text-[var(--faint)] uppercase tracking-wider px-3 block mb-2 transition-all duration-300 overflow-hidden whitespace-nowrap ${
                    collapsed ? "max-h-0 opacity-0 mb-0" : "max-h-6 opacity-100"
                  }`}
                >
                  {group.label}
                </span>
                <nav className="space-y-0.5">{renderNav(group.items)}</nav>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer: profile */}
      <div className="space-y-4">
        <div
          onClick={() => setShowProfileDropdown(!showProfileDropdown)}
          className={`flex items-center hover:bg-[var(--surface-2)] rounded-xl cursor-pointer select-none transition-all duration-300 relative border border-transparent hover:border-[var(--border-2)] ${
            collapsed ? "p-1.5 justify-center" : "p-2 gap-3"
          }`}
        >
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={optimizeCloudinaryUrl(avatarUrl)}
              alt={displayName}
              className="w-9 h-9 rounded-full object-cover shadow-sm flex-none"
            />
          ) : (
            <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-[#5b8def] to-[var(--accent)] text-white flex items-center justify-center font-bold text-xs select-none shadow-sm flex-none">
              {initials}
            </div>
          )}
          <div
            className={`leading-tight min-w-0 flex-1 transition-all duration-300 overflow-hidden ${
              collapsed ? "w-0 opacity-0 pointer-events-none" : "w-full opacity-100"
            }`}
          >
            <span className="text-xs font-extrabold block text-[var(--ink)] truncate">
              {displayName}
            </span>
            <span className="text-[10px] text-[var(--faint)] font-bold uppercase tracking-wider block mt-0.5 truncate">
              {roleLabel}
            </span>
          </div>
          <ChevronDown
            className={`w-4 h-4 text-[var(--faint)] shrink-0 transition-all duration-300 overflow-hidden ${
              collapsed ? "w-0 opacity-0 pointer-events-none" : "opacity-100"
            }`}
          />

          {showProfileDropdown && (
            <div className="absolute bottom-12 left-0 w-full bg-[var(--surface)] text-[var(--ink)] rounded-xl shadow-2xl border border-[var(--border)] py-1.5 z-50 text-xs anim-fade-in block">
              <div className="px-3 py-2 border-b border-[var(--border-2)]">
                <p className="font-semibold text-[var(--ink)]">Signed in as</p>
                <p className="text-[10px] text-[var(--faint)] font-mono truncate">
                  {principal?.email}
                </p>
              </div>
              {(isUser || isCustomer) && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowProfileDropdown(false);
                    guard.attemptLeave(() => router.push("/dashboard/account"));
                  }}
                  className="w-full px-3 py-2 text-left hover:bg-[var(--surface-2)] font-bold text-[var(--ink)] flex items-center justify-between cursor-pointer"
                >
                  <span>My account</span>
                  <UserRound className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowProfileDropdown(false);
                  guard.attemptLeave(handleSignOut);
                }}
                className="w-full px-3 py-2 text-left hover:bg-[var(--surface-2)] text-red-500 flex items-center justify-between cursor-pointer"
              >
                <span>Sign Out</span>
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
