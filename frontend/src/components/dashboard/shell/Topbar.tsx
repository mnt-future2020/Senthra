"use client";

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";

// Page titles for the real routes. Falls back to a generic label otherwise.
const TITLES: Record<string, string> = {
  settings: "Settings",
  users: "Users & Roles",
};

export function Topbar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { admin } = useAuth();
  const pathname = usePathname();

  const segment = pathname.split("/")[2] ?? "";
  const title = TITLES[segment] ?? "Dashboard";

  return (
    <header className="sticky top-0 z-30 bg-[var(--surface)] border-b border-[var(--border)] px-4 py-3 md:px-8 md:py-4 flex items-center justify-between gap-4 backdrop-blur-md bg-opacity-95">
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleSidebar}
          className="p-1.5 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--muted)] cursor-pointer"
          title="Expand/Collapse panel"
        >
          <Menu className="w-5 h-5 stroke-2" />
        </button>
        <div className="leading-tight">
          <h1 className="font-extrabold text-lg md:text-xl tracking-tight text-[var(--ink)]">
            {title}
          </h1>
          <p className="text-xs text-[var(--muted)] hidden sm:block">
            {admin?.email} &middot;{" "}
            {new Date().toLocaleDateString("en-US", {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}
          </p>
        </div>
      </div>
    </header>
  );
}
