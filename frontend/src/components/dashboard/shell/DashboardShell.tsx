"use client";

import * as React from "react";

import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { PageActionsSlotContext } from "@/components/ui/PageActions";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { Toasts } from "./Toasts";

// App frame shared by every /dashboard/* route: sidebar + topbar + the route
// content + global toasts.
export function DashboardShell({ children }: { children: React.ReactNode }) {
  // The top bar's page-actions slot. Set by a CALLBACK REF (not an effect), so it lands during the
  // same commit that creates the element and the page's controls appear before the first paint.
  const [actionSlot, setActionSlot] = React.useState<HTMLElement | null>(null);
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
          <Topbar onToggleSidebar={handleToggleSidebar} actionSlotRef={setActionSlot} />
          <PageActionsSlotContext value={actionSlot}>
            <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-8 w-full space-y-6">
              {children}
            </div>
          </PageActionsSlotContext>
        </main>

        <Toasts />
      </div>
    </NavigationGuardProvider>
  );
}
