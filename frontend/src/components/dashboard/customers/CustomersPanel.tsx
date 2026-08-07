"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Building2, Tag } from "lucide-react";

import { PageActions } from "@/components/ui/PageActions";
import { TabPills } from "@/components/ui/TabPills";
import { CustomersView } from "./CustomersView";
import { CustomerCategoriesView } from "./CustomerCategoriesView";
import { useAuth } from "@/hooks/useAuth";

type Tab = "customers" | "categories";

const TABS: { id: Tab; label: string; icon: React.ElementType; perm: string }[] = [
  { id: "customers", label: "Customers", icon: Building2, perm: "customers.view" },
  { id: "categories", label: "Categories", icon: Tag, perm: "categories.view" },
];

// Customers module shell: the customer list plus the category master used to classify the stock
// customers submit to us. That master used to sit in Settings, which was the last domain
// master-data left there — every other one (Warehouses → Types, Suppliers → Types, Inventory Hub →
// IRM Types/Categories) already lives beside the module that owns it. The active tab lives in ?tab=
// so it survives a refresh.
export function CustomersPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();

  const visibleTabs = TABS.filter((t) => can(t.perm));
  const requested = searchParams.get("tab");
  const activeTab: Tab =
    visibleTabs.find((t) => t.id === requested)?.id ?? visibleTabs[0]?.id ?? "customers";
  const selectTab = (t: Tab) => router.replace(`/dashboard/customers?tab=${t}`, { scroll: false });

  return (
    <div className="flex h-full flex-col gap-6">
      <PageActions>
        <TabPills tabs={visibleTabs} active={activeTab} onSelect={selectTab} ariaLabel="Customers sections" />
      </PageActions>

      <div className="flex min-h-0 flex-1 flex-col">
        {activeTab === "customers" ? <CustomersView /> : <CustomerCategoriesView />}
      </div>
    </div>
  );
}
