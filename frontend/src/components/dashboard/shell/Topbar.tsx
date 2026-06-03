"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Menu, Search, Calendar, Bell, Plus } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";

export function Topbar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { admin } = useAuth();
  const pathname = usePathname();
  const d = useDashboard();
  const [showNotifDropdown, setShowNotifDropdown] = React.useState(false);

  const unread = d.notifications.filter((n) => !n.read).length;
  const segment = pathname.split("/")[2] || "overview";
  const title = segment === "settings" ? "Settings" : `${segment} summary`;

  return (
    <header className="sticky top-0 z-30 bg-[var(--surface)] border-b border-[var(--border)] px-4 py-3 md:px-8 md:py-4 flex items-center justify-between gap-4 backdrop-blur-md bg-opacity-95">
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleSidebar}
          className="p-1.5 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--muted)] cursor-pointer"
          title="Expand/Collapse panel"
        >
          <Menu className="w-5 h-5 stroke-2" />
        </button>
        <div className="leading-tight">
          <h1 className="font-extrabold text-lg md:text-xl tracking-tight text-[var(--ink)] capitalize">
            {title}
          </h1>
          <p className="text-xs text-[var(--muted)] hidden sm:block">
            {admin?.email} &middot;{" "}
            {new Date().toLocaleDateString("en-US", {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}
          </p>
        </div>
      </div>

      <div className="hidden lg:flex items-center relative w-72">
        <Search className="absolute left-3 top-3 w-4 h-4 text-[var(--faint)]" />
        <input
          type="text"
          placeholder="Search statements references, names..."
          value={d.searchQuery}
          onChange={(e) => d.setSearchQuery(e.target.value)}
          className="w-full bg-[var(--surface-2)] text-[var(--ink)] text-xs pl-9 pr-4 py-2.5 rounded-xl border border-[var(--border)] outline-none focus:border-[var(--accent)] transition-all"
        />
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            const date = prompt("Specify active date range:", "Jan 1 - Jun 1, 2026");
            if (date) d.pushToast(`Date range updated to ${date}.`, "info");
          }}
          className="hidden md:flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-[var(--surface-2)] hover:border-[var(--accent)] border border-[var(--border)] text-xs font-semibold text-[var(--ink)] cursor-pointer transition-all"
        >
          <Calendar className="w-4 h-4 text-[var(--faint)]" />
          <span>Jan 1 – Jun 1, 2026</span>
        </button>

        <div className="relative">
          <button
            onClick={() => setShowNotifDropdown(!showNotifDropdown)}
            className="p-2.5 bg-[var(--surface)] hover:bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)] border border-[var(--border)] rounded-xl transition-colors cursor-pointer relative"
          >
            <Bell className="w-4.5 h-4.5" />
            {unread > 0 && (
              <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[var(--neg)] shadow-sm" />
            )}
          </button>

          {showNotifDropdown && (
            <div className="fixed right-4 left-4 top-16 sm:top-auto sm:left-auto sm:right-0 sm:absolute mt-2 w-auto sm:w-80 bg-[var(--surface)] text-[var(--ink)] border border-[var(--border)] rounded-xl shadow-2xl py-2 z-50 text-xs anim-fade-in block">
              <div className="px-4 py-2 border-b border-[var(--border-2)] flex justify-between items-center bg-[var(--surface-2)] rounded-t-xl">
                <span className="font-extrabold uppercase tracking-wider text-[var(--ink)] text-[10px]">
                  Updates Ledger
                </span>
                <button
                  onClick={() => d.markAllNotificationsRead()}
                  className="text-[10px] text-[var(--accent)] font-extrabold hover:underline"
                >
                  Clear alerts
                </button>
              </div>
              <div className="max-h-64 overflow-y-auto py-1">
                {d.notifications.length === 0 ? (
                  <div className="p-4 text-center text-[var(--faint)]">
                    No registered system warnings
                  </div>
                ) : (
                  d.notifications.map((n) => (
                    <div
                      key={n.id}
                      onClick={() => {
                        d.markNotificationRead(n.id);
                        setShowNotifDropdown(false);
                      }}
                      className={`p-3 border-b border-[var(--border-2)] hover:bg-[var(--surface-2)] transition-colors cursor-pointer ${
                        !n.read
                          ? "bg-[var(--accent-3)] border-l-4 border-[var(--accent)]"
                          : ""
                      }`}
                    >
                      <p className="font-bold text-xs text-[var(--ink)] leading-snug">
                        {n.title}
                      </p>
                      <span className="text-[10px] text-[var(--faint)] block mt-1">
                        {n.time}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={() => d.setShowAddTxnModal(true)}
          className="px-4 py-2 bg-[var(--pos)] text-white hover:opacity-95 rounded-xl font-extrabold text-xs transition-all cursor-pointer flex items-center gap-1 shadow-xs accent-glow"
        >
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Add TXN</span>
        </button>
      </div>
    </header>
  );
}
