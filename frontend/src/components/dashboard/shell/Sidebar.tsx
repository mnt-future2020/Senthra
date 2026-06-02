"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  Users,
  Receipt,
  LayoutDashboard,
  Settings,
  MessageSquare,
  ShoppingBag,
  X,
  ChevronDown,
  Award,
  LogOut,
} from "lucide-react";

import { useAuth } from "@/lib/auth";
import { useDashboard } from "../DashboardProvider";

type NavItem = {
  href: string;
  label: string;
  icon: React.ElementType;
  badge?: number;
};

const MENU: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/dashboard/customers", label: "Customers", icon: Users },
  { href: "/dashboard/invoices", label: "Invoices", icon: Receipt },
  { href: "/dashboard/products", label: "Products", icon: ShoppingBag },
];

const WORKSPACE: NavItem[] = [
  { href: "/dashboard/messages", label: "Messages", icon: MessageSquare, badge: 3 },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
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
  const { admin, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const d = useDashboard();
  const [showProfileDropdown, setShowProfileDropdown] = React.useState(false);

  const pendingCount = d.transactions.filter((t) => t.status === "pending").length;

  const handleSignOut = async () => {
    await logout();
    router.replace("/login");
  };

  const renderNav = (items: NavItem[]) =>
    items.map((item) => {
      const Icon = item.icon;
      const active = pathname === item.href;
      const badge =
        item.href === "/dashboard/invoices" ? pendingCount : item.badge;
      return (
        <Link
          key={item.href}
          href={item.href}
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
          {badge ? (
            <span
              className={`px-1.5 py-0.5 bg-[var(--accent)] text-white text-[9px] font-black rounded-full select-none num transition-all duration-300 overflow-hidden ${
                collapsed
                  ? "w-0 opacity-0 p-0 pointer-events-none"
                  : "opacity-100 ml-1"
              }`}
            >
              {badge}
            </span>
          ) : null}
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
          <div className="w-9 h-9 rounded-xl font-black bg-gradient-to-br from-[var(--accent)] to-indigo-600 text-white flex items-center justify-center text-lg shadow-md accent-glow select-none flex-shrink-0">
            S
          </div>
          <div
            className={`leading-none transition-all duration-300 overflow-hidden whitespace-nowrap ${
              collapsed ? "w-0 opacity-0 pointer-events-none" : "w-32 opacity-100"
            }`}
          >
            <h2 className="font-extrabold text-base tracking-tight text-[var(--ink)]">
              Senthra
            </h2>
            <span className="text-[10px] uppercase font-bold tracking-widest text-[var(--faint)] mt-0.5 block">
              Admin Suite
            </span>
          </div>
          <button
            onClick={onCloseMobile}
            className="md:hidden ml-auto p-1 border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--muted)] rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Nav */}
        <div className="space-y-5">
          <div>
            <span
              className={`text-[10px] font-extrabold text-[var(--faint)] uppercase tracking-wider px-3 block mb-2 transition-all duration-300 overflow-hidden whitespace-nowrap ${
                collapsed ? "max-h-0 opacity-0 mb-0" : "max-h-6 opacity-100"
              }`}
            >
              Console Menu
            </span>
            <nav className="space-y-0.5">{renderNav(MENU)}</nav>
          </div>
          <div>
            <span
              className={`text-[10px] font-extrabold text-[var(--faint)] uppercase tracking-wider px-3 block mb-2 transition-all duration-300 overflow-hidden whitespace-nowrap ${
                collapsed ? "max-h-0 opacity-0 mb-0" : "max-h-6 opacity-100"
              }`}
            >
              Workspace
            </span>
            <nav className="space-y-0.5">{renderNav(WORKSPACE)}</nav>
          </div>
        </div>
      </div>

      {/* Footer: upsell + profile */}
      <div className="space-y-4">
        {d.userTier !== "Enterprise Owner" && (
          <div
            className={`bg-gradient-to-br from-[var(--surface-2)] to-[var(--bg)] border border-[var(--border)] rounded-2xl text-xs flex flex-col gap-1.5 shadow-xs relative overflow-hidden group transition-all duration-300 ${
              collapsed
                ? "max-h-0 p-0 border-none opacity-0 pointer-events-none"
                : "max-h-48 p-3.5 opacity-100"
            }`}
          >
            <div className="absolute top-0 right-0 w-8 h-8 bg-[var(--accent)] opacity-5 rounded-bl-full group-hover:scale-150 transition-all"></div>
            <h4 className="font-extrabold text-[var(--ink)] flex items-center gap-1.5 whitespace-nowrap">
              Upgrade to Pro{" "}
              <Award className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
            </h4>
            <p className="text-[11px] text-[var(--muted)] leading-relaxed">
              Unlock automated accounting forecasting & dedicated nodes slots.
            </p>
            <button
              onClick={() => d.setShowUpgradeModal(true)}
              className="w-full py-2 bg-[var(--accent)] text-white rounded-lg font-extrabold text-[11px] hover:opacity-90 transition-all cursor-pointer shadow-xs"
            >
              Learn Specs
            </button>
          </div>
        )}

        <div
          onClick={() => setShowProfileDropdown(!showProfileDropdown)}
          className={`flex items-center hover:bg-[var(--surface-2)] rounded-xl cursor-pointer select-none transition-all duration-300 relative border border-transparent hover:border-[var(--border-2)] ${
            collapsed ? "p-1.5 justify-center" : "p-2 gap-3"
          }`}
        >
          <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-[#5b8def] to-[var(--accent)] text-white flex items-center justify-center font-bold text-xs select-none shadow-sm flex-none">
            SA
          </div>
          <div
            className={`leading-tight min-w-0 flex-1 transition-all duration-300 overflow-hidden ${
              collapsed ? "w-0 opacity-0 pointer-events-none" : "w-full opacity-100"
            }`}
          >
            <span className="text-xs font-extrabold block text-[var(--ink)] truncate">
              {admin?.name || admin?.email || "Super Admin"}
            </span>
            <span className="text-[10px] text-[var(--faint)] font-bold uppercase tracking-wider block mt-0.5 whitespace-nowrap">
              {d.userTier}
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
                <p className="font-semibold text-[var(--ink)]">User Reference</p>
                <p className="text-[10px] text-[var(--faint)] font-mono">
                  {admin?.email}
                </p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  d.setShowUpgradeModal(true);
                  setShowProfileDropdown(false);
                }}
                className="w-full px-3 py-2 text-left hover:bg-[var(--surface-2)] font-bold text-[var(--accent)] flex items-center justify-between cursor-pointer"
              >
                <span>System Upgrade</span>
                <Award className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowProfileDropdown(false);
                  handleSignOut();
                }}
                className="w-full px-3 py-2 text-left hover:bg-[var(--surface-2)] text-red-500 flex items-center justify-between cursor-pointer border-t border-[var(--border-2)]"
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
