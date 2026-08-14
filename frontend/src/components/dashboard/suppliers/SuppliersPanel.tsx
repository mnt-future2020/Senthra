"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Factory, Truck } from "lucide-react";

import { PageActions } from "@/components/ui/PageActions";
import { TabPills } from "@/components/ui/TabPills";
import { SuppliersView } from "./SuppliersView";
import { SupplierTypesView } from "./SupplierTypesView";
import { useAuth } from "@/hooks/useAuth";

type Tab = "suppliers" | "types";

const TABS: { id: Tab; label: string; icon: React.ElementType; perm: string }[] = [
  { id: "suppliers", label: "Suppliers", icon: Truck, perm: "suppliers.view" },
  { id: "types", label: "Types", icon: Factory, perm: "supplier_types.view" },
];

// Suppliers module shell: the supplier list plus its classification master (Types),
// co-located here rather than in Settings — mirrors the Warehouses / Users & Roles
// pattern. The active tab lives in ?tab= so it survives a refresh.
export function SuppliersPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();

  const visibleTabs = TABS.filter((t) => can(t.perm));
  const requested = searchParams.get("tab");
  const activeTab: Tab =
    visibleTabs.find((t) => t.id === requested)?.id ?? visibleTabs[0]?.id ?? "suppliers";
  const selectTab = (t: Tab) => router.replace(`/dashboard/suppliers?tab=${t}`, { scroll: false });

  return (
    <div className="flex h-full flex-col gap-6">
      <PageActions>
        <TabPills tabs={visibleTabs} active={activeTab} onSelect={selectTab} ariaLabel="Suppliers sections" />
      </PageActions>

      <div className="flex min-h-0 flex-1 flex-col">
        {activeTab === "suppliers" ? <SuppliersView /> : <SupplierTypesView />}
      </div>
    </div>
  );
}
