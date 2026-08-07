"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Boxes, Warehouse as WarehouseIcon } from "lucide-react";

import { PageActions } from "@/components/ui/PageActions";
import { TabPills } from "@/components/ui/TabPills";
import { WarehousesView } from "./WarehousesView";
import { WarehouseTypesView } from "./WarehouseTypesView";
import { useAuth } from "@/hooks/useAuth";

type Tab = "warehouses" | "types";

const TABS: { id: Tab; label: string; icon: React.ElementType; perm: string }[] = [
  { id: "warehouses", label: "Warehouses", icon: WarehouseIcon, perm: "warehouse.view" },
  { id: "types", label: "Types", icon: Boxes, perm: "warehouse_types.view" },
];

// Warehouses module shell: the warehouse list plus its classification master (Types),
// co-located here rather than buried in Settings — mirrors how Users & Roles hosts
// Job titles / Departments. The active tab lives in ?tab= so it survives a refresh.
export function WarehousesPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();

  const visibleTabs = TABS.filter((t) => can(t.perm));
  const requested = searchParams.get("tab");
  const activeTab: Tab =
    visibleTabs.find((t) => t.id === requested)?.id ?? visibleTabs[0]?.id ?? "warehouses";
  const selectTab = (t: Tab) => router.replace(`/dashboard/warehouses?tab=${t}`, { scroll: false });

  return (
    <div className="flex h-full flex-col gap-6">
      <PageActions>
        <TabPills tabs={visibleTabs} active={activeTab} onSelect={selectTab} ariaLabel="Warehouses sections" />
      </PageActions>

      <div className="flex min-h-0 flex-1 flex-col">
        {activeTab === "warehouses" ? <WarehousesView /> : <WarehouseTypesView />}
      </div>
    </div>
  );
}
