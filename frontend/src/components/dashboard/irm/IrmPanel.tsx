"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Boxes, Layers, Tags } from "lucide-react";

import { ListPageHeader } from "@/components/ui/ListPageHeader";
import { IrmItemsView } from "./IrmItemsView";
import { IrmTypesView } from "./IrmTypesView";
import { IrmCategoriesView } from "./IrmCategoriesView";
import { useAuth } from "@/hooks/useAuth";

export type IrmTab = "catalogue" | "types" | "categories";
type Tab = IrmTab;

// Exported so a host (e.g. the Inventory Hub) can render its own tab switcher with the same
// labels/icons/permissions and drive IrmPanel in controlled mode.
export const IRM_TABS: { id: Tab; label: string; icon: React.ElementType; perm: string }[] = [
  { id: "catalogue", label: "Catalogue", icon: Boxes, perm: "irm.view" },
  { id: "types", label: "Types", icon: Layers, perm: "irm_types.view" },
  { id: "categories", label: "Categories", icon: Tags, perm: "irm_categories.view" },
];
const TABS = IRM_TABS;

// IRM Catalogue module shell: the item list plus its Type and Category masters,
// co-located here rather than in Settings — mirrors the Warehouses / Users & Roles
// pattern. The active tab lives in ?tab= so it survives a refresh.
//
// `embedded` mode renders the same module without its own page header and switches tabs via
// internal state instead of the URL — used inside the Inventory Hub's IRM › Catalogue view so it
// stays put rather than navigating to /dashboard/irm.
export function IrmPanel({ embedded = false, tab }: { embedded?: boolean; tab?: Tab } = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();

  const visibleTabs = TABS.filter((t) => can(t.perm));
  // Controlled embed: the host (Inventory Hub) owns the tab and renders its own switcher.
  const controlled = embedded && tab !== undefined;
  // Uncontrolled embedded path: persist the active tab in ?irm_tab= (namespaced to avoid
  // clashing with the Inventory Hub's own ?tab= param). Standalone path uses ?tab=.
  const requested = controlled
    ? tab
    : embedded
      ? (searchParams.get("irm_tab") as Tab | null)
      : (searchParams.get("tab") as Tab | null);
  const activeTab: Tab =
    visibleTabs.find((t) => t.id === requested)?.id ?? visibleTabs[0]?.id ?? "catalogue";
  const selectTab = (t: Tab) => {
    const p = new URLSearchParams(window.location.search);
    if (embedded) {
      p.set("irm_tab", t);
    } else {
      p.set("tab", t);
    }
    router.replace(`${window.location.pathname}?${p.toString()}`, { scroll: false });
  };

  const content =
    activeTab === "catalogue" ? <IrmItemsView /> : activeTab === "types" ? <IrmTypesView /> : <IrmCategoriesView />;

  // Controlled embed renders only the active view; the switcher lives in the host's action bar.
  if (controlled) {
    return <div className="flex h-full min-h-0 flex-col">{content}</div>;
  }

  const tabSwitcher =
    visibleTabs.length > 1 ? (
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
    ) : null;

  return (
    <div className={`flex h-full flex-col ${embedded ? "gap-4" : "gap-6"}`}>
      {embedded ? (
        tabSwitcher ? <div className="flex shrink-0">{tabSwitcher}</div> : null
      ) : (
        <ListPageHeader
          title="IRM Catalogue"
          subtitle="Company-owned internal stock items, with the type and category lists used to classify them."
          right={tabSwitcher}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col">{content}</div>
    </div>
  );
}
