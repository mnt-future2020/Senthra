"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Briefcase, Building2, Shield, Users2 } from "lucide-react";

import { RolesView } from "./RolesView";
import { UsersView } from "./UsersView";
import { DepartmentsView } from "./DepartmentsView";
import { JobTitlesView } from "./JobTitlesView";
import { useAuth } from "@/hooks/useAuth";

type Tab = "users" | "roles" | "departments" | "jobTitles";

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "users", label: "Users", icon: Users2 },
  { id: "roles", label: "Roles", icon: Shield },
  { id: "departments", label: "Departments", icon: Building2 },
  { id: "jobTitles", label: "Job titles", icon: Briefcase },
];

export function UsersRolesPanel() {
  // The active tab lives in ?tab= so it survives a refresh and is shareable, and so
  // returning from a role form page lands back on the Roles tab.
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();

  // Tabs are permission-gated: the Roles tab needs roles.view; the Users,
  // Departments and Job titles tabs (employee data) need users.view. Super-admin holds all.
  const visibleTabs = TABS.filter((t) =>
    can(t.id === "roles" ? "roles.view" : "users.view"),
  );
  const requested = searchParams.get("tab");
  const activeTab: Tab =
    visibleTabs.find((t) => t.id === requested)?.id ?? visibleTabs[0]?.id ?? "users";
  const selectTab = (t: Tab) => router.replace(`/dashboard/users?tab=${t}`, { scroll: false });

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
                onClick={() => selectTab(t.id)}
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
        {activeTab === "users" ? (
          <UsersView />
        ) : activeTab === "roles" ? (
          <RolesView />
        ) : activeTab === "departments" ? (
          <DepartmentsView />
        ) : (
          <JobTitlesView />
        )}
      </div>
    </div>
  );
}
