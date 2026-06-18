"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Factory, Truck } from "lucide-react";

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
      <div
        className="flex shrink-0 flex-col gap-4 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs sm:flex-row sm:items-center sm:justify-between"
        style={{ borderRadius: "var(--radius)" }}
      >
        <div className="space-y-0.5">
          <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">Suppliers</h2>
          <p className="text-xs text-[var(--muted)]">
            The organisations you procure stock from and the type list used to classify them.
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
        {activeTab === "suppliers" ? <SuppliersView /> : <SupplierTypesView />}
      </div>
    </div>
  );
}
