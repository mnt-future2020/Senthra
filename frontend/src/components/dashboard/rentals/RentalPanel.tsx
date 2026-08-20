"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeftRight, CalendarClock, CalendarPlus, Package, Tags } from "lucide-react";

import { PageActions } from "@/components/ui/PageActions";
import { TabPills } from "@/components/ui/TabPills";
import { useAuth } from "@/hooks/useAuth";
import { HireExtensionsView } from "./HireExtensionsView";
import { HireMovementsView } from "./HireMovementsView";
import { OnHireView } from "./OnHireView";
import { RentalCategoriesView } from "./RentalCategoriesView";
import { RentalItemsView } from "./RentalItemsView";

export type RentalTab = "catalogue" | "on-hire" | "movements" | "extensions" | "categories";

export const RENTAL_TABS: { id: RentalTab; label: string; icon: React.ElementType; perm: string }[] = [
  { id: "catalogue", label: "Catalogue", icon: Package, perm: "rentals.view" },
  { id: "on-hire", label: "On hire", icon: CalendarClock, perm: "rentals.view" },
  // Between the live list and the master data, which is where it sits in a user's head: what is out
  // now, then everything that has ever moved, then the vocabulary both are described in.
  { id: "movements", label: "Movements", icon: ArrowLeftRight, perm: "rentals.view" },
  // Beside Movements because it is the same kind of thing — a chronological register of what has
  // happened to hires — and separate from it because an extension is a commercial change, not a
  // physical movement: nothing arrives, nothing goes back, and the money is the whole of it.
  { id: "extensions", label: "Extensions", icon: CalendarPlus, perm: "rentals.view" },
  { id: "categories", label: "Categories", icon: Tags, perm: "rental_categories.view" },
];

/**
 * Rentals module shell: the hire catalogue, the live hires, and the category master.
 *
 * Lives INSIDE the Inventory Hub (Inventory → Rentals), exactly as the IRM Catalogue does — the two
 * are the same kind of thing to a user, so they are reached the same way. `embedded` renders the
 * module without its own page header and takes the active tab from the host, which owns the
 * switcher in its action bar. Standalone mode keeps `?tab=` in the URL for anyone who deep-links
 * the old route.
 */
export function RentalPanel({ embedded = false, tab }: { embedded?: boolean; tab?: RentalTab } = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();

  const visibleTabs = RENTAL_TABS.filter((t) => can(t.perm));
  // Controlled embed: the host (Inventory Hub) owns the tab and renders its own switcher.
  const controlled = embedded && tab !== undefined;
  const requested = controlled ? tab : (searchParams.get("tab") as RentalTab | null);
  const activeTab: RentalTab = visibleTabs.find((t) => t.id === requested)?.id ?? visibleTabs[0]?.id ?? "catalogue";

  const selectTab = (t: RentalTab) => {
    const p = new URLSearchParams(window.location.search);
    p.set("tab", t);
    // The filters belong to the tab that owns them — carrying ?status from On hire into the
    // catalogue would silently filter a list by a value it does not understand.
    p.delete("status");
    // The register's own filters go the same way as the on-hire status, and for the same reason:
    // carrying ?dir or a date period into the catalogue would filter a list by values it has never
    // heard of, and the user would see an empty page with no visible cause.
    p.delete("dir");
    p.delete("from");
    p.delete("to");
    p.delete("live");
    p.delete("q");
    p.delete("page");
    router.replace(`${window.location.pathname}?${p.toString()}`, { scroll: false });
  };

  const content =
    activeTab === "catalogue" ? (
      <RentalItemsView />
    ) : activeTab === "on-hire" ? (
      <OnHireView />
    ) : activeTab === "movements" ? (
      <HireMovementsView />
    ) : activeTab === "extensions" ? (
      <HireExtensionsView />
    ) : (
      <RentalCategoriesView />
    );

  if (controlled) return <div className="flex h-full min-h-0 flex-col">{content}</div>;

  return (
    <div className="flex h-full flex-col gap-6">
      <PageActions>
        <TabPills tabs={visibleTabs} active={activeTab} onSelect={selectTab} ariaLabel="Rentals sections" />
      </PageActions>
      <div className="flex min-h-0 flex-1 flex-col">{content}</div>
    </div>
  );
}
