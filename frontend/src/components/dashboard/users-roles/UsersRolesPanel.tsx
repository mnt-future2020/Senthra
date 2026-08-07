"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Briefcase, Building2, Shield, Users2 } from "lucide-react";

import { PageActions } from "@/components/ui/PageActions";
import { TabPills } from "@/components/ui/TabPills";
import { RolesView } from "@/components/dashboard/users-roles/roles/RolesView";
import { UsersView } from "./users/UsersView";
import { DepartmentsView } from "@/components/dashboard/users-roles/departments/DepartmentsView";
import { JobTitlesView } from "@/components/dashboard/users-roles/job-titles/JobTitlesView";
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
      <PageActions>
        <TabPills tabs={visibleTabs} active={activeTab} onSelect={selectTab} ariaLabel="Users & Roles sections" />
      </PageActions>

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
