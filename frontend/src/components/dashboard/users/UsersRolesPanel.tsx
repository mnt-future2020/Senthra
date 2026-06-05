"use client";

import * as React from "react";
import { Shield, Users2 } from "lucide-react";

import { RolesView } from "./RolesView";
import { UsersView } from "./UsersView";
import { useAuth } from "@/hooks/useAuth";

type Tab = "users" | "roles";

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "users", label: "Users", icon: Users2 },
  { id: "roles", label: "Roles", icon: Shield },
];

export function UsersRolesPanel() {
  const [tab, setTab] = React.useState<Tab>("users");
  const { admin, can } = useAuth();

  // Role configuration is super-admin only; the Users tab needs users.manage.
  const visibleTabs = TABS.filter((t) =>
    t.id === "roles" ? Boolean(admin) : can("users.manage"),
  );
  const activeTab: Tab = visibleTabs.some((t) => t.id === tab)
    ? tab
    : visibleTabs[0]?.id ?? "users";

  return (
    <div className="flex h-full flex-col gap-6">
      <div
        className="flex shrink-0 flex-col gap-4 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs sm:flex-row sm:items-center sm:justify-between"
        style={{ borderRadius: "var(--radius)" }}
      >
        <div className="space-y-0.5">
          <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">
            Users &amp; Roles
          </h2>
          <p className="text-xs text-[var(--muted)]">
            Create the people who run the system and the roles they hold.
          </p>
        </div>
        {visibleTabs.length > 1 && (
          <div className="flex gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
            {visibleTabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-bold transition-all ${
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
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {activeTab === "users" ? <UsersView /> : <RolesView />}
      </div>
    </div>
  );
}
