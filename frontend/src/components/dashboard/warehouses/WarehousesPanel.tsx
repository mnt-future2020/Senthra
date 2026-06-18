"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Boxes, Warehouse as WarehouseIcon } from "lucide-react";

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
      <div
        className="flex shrink-0 flex-col gap-4 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs sm:flex-row sm:items-center sm:justify-between"
        style={{ borderRadius: "var(--radius)" }}
      >
        <div className="space-y-0.5">
          <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">Warehouses</h2>
          <p className="text-xs text-[var(--muted)]">
            Physical stock locations and the type list used to classify them.
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
        {activeTab === "warehouses" ? <WarehousesView /> : <WarehouseTypesView />}
      </div>
    </div>
  );
}
