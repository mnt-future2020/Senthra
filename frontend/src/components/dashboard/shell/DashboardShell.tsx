"use client";

import * as React from "react";

import { useDashboard } from "@/hooks/useDashboard";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import ReceiptModal from "../modals/ReceiptModal";
import AddTxnModal from "../modals/AddTxnModal";
import UpgradeModal from "../modals/UpgradeModal";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { Toasts } from "./Toasts";

// App frame shared by every /dashboard/* route: sidebar + topbar + the route
// content + global toasts and modals.
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const d = useDashboard();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = React.useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = React.useState(false);

  const handleToggleSidebar = () => {
    setIsMobileSidebarOpen(true);
    if (window.innerWidth >= 768) {
      setIsSidebarCollapsed((v) => !v);
    }
  };

  return (
    <NavigationGuardProvider>
      <div
        className="flex bg-[var(--bg)] text-[var(--ink)] h-screen overflow-hidden tweak-transition"
        id="app"
      >
        <Sidebar
          collapsed={isSidebarCollapsed}
          mobileOpen={isMobileSidebarOpen}
          onCloseMobile={() => setIsMobileSidebarOpen(false)}
        />

        {isMobileSidebarOpen && (
          <div
            onClick={() => setIsMobileSidebarOpen(false)}
            className="fixed inset-0 bg-black/50 z-30 md:hidden"
          />
        )}

        <main className="flex-1 flex flex-col min-w-0 transition-all duration-300">
          <Topbar onToggleSidebar={handleToggleSidebar} />
          <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-8 w-full space-y-6">
            {children}
          </div>
        </main>

        <Toasts />

        {/* Global modals */}
        {d.selectedTxn && (
          <ReceiptModal
            transaction={d.selectedTxn}
            onClose={() => d.setSelectedTxn(null)}
            onUpdateStatus={d.updateTransactionStatus}
            onDelete={d.deleteTransaction}
          />
        )}
        {d.showAddTxnModal && (
          <AddTxnModal
            onClose={() => d.setShowAddTxnModal(false)}
            onAdd={d.addTransaction}
          />
        )}
        {d.showUpgradeModal && (
          <UpgradeModal
            onClose={() => d.setShowUpgradeModal(false)}
            onUpgradeSuccess={d.upgradeTier}
          />
        )}
      </div>
    </NavigationGuardProvider>
  );
}
