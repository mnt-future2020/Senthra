"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ShieldCheck, Palette, Plug, Mail, MailCheck, Paintbrush, Tag } from "lucide-react";

import { AccountSection } from "./account/AccountSection";
import { CategoriesView } from "./categories/CategoriesView";
import { SecuritySection } from "./account/SecuritySection";
import { BrandingSection } from "./branding/BrandingSection";
import { AppearanceSection } from "./appearance/AppearanceSection";
import { IntegrationsSection } from "./integrations/IntegrationsSection";
import { CloudinarySection } from "./integrations/CloudinarySection";
import { EmailSection } from "./email/EmailSection";
import { EmailTemplatesSection } from "./email/EmailTemplatesSection";
import { useNavigationGuard } from "@/providers/NavigationGuardProvider";
import { useAuth } from "@/hooks/useAuth";
import { SessionsCard } from "@/components/account/SessionsCard";
import type { AppearanceProps, Section } from "./types";

// Each section is gated: "account" (the super-admin's own login) is admin-only;
// the rest need the matching permission. The super-admin holds everything.
const NAV: {
  id: Section;
  label: string;
  icon: React.ElementType;
  desc: string;
  requires:
    | "admin"
    | "settings.view"
    | "email_templates.view"
    | "categories.view";
}[] = [
  { id: "account", label: "Account & Security", icon: ShieldCheck, desc: "Email & password", requires: "admin" },
  { id: "branding", label: "Branding", icon: Paintbrush, desc: "Logo, name & theme text", requires: "settings.view" },
  { id: "appearance", label: "Appearance", icon: Palette, desc: "Theme & layout", requires: "settings.view" },
  { id: "integrations", label: "Integrations", icon: Plug, desc: "Google Sign-In", requires: "settings.view" },
  { id: "email", label: "Email", icon: Mail, desc: "SMTP & delivery", requires: "settings.view" },
  { id: "email-templates", label: "Email Templates", icon: MailCheck, desc: "Customize sent emails", requires: "email_templates.view" },
  { id: "categories", label: "Categories", icon: Tag, desc: "Stock category list", requires: "categories.view" },
];

export function SettingsPanel(appearance: AppearanceProps) {
  const guard = useNavigationGuard();
  const { admin, can } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Only the sections this principal may use.
  const visible = NAV.filter((item) =>
    item.requires === "admin" ? Boolean(admin) : can(item.requires),
  );
  // The active section comes from ?section= so it survives a refresh and is
  // shareable/bookmarkable, falling back to the first section this principal can
  // actually use (so a staff user who can't see "Account" still lands somewhere valid).
  const requested = searchParams.get("section");
  const activeSection: Section =
    visible.find((s) => s.id === requested)?.id ?? visible[0]?.id ?? "account";

  // Switching sections updates the URL. The current one may have unsaved edits, so
  // confirm first (the guard is a no-op when nothing is dirty).
  const requestSection = (target: Section) => {
    if (target === activeSection) return;
    guard.attemptLeave(() =>
      router.replace(`/dashboard/settings?section=${target}`, { scroll: false }),
    );
  };

  return (
    <div className="w-full">
      {/* items-stretch → the nav card matches the content card's height. */}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-stretch">
        {/* Sub-navigation card. Items are sticky INSIDE the card so they stay
            pinned at the top while the (often tall) section content scrolls. */}
        <nav
          className="border border-[var(--border)] bg-[var(--surface)] p-2 shadow-xs lg:w-60"
          style={{ borderRadius: "var(--radius)" }}
        >
          <div className="flex gap-1 overflow-x-auto lg:sticky lg:top-2 lg:flex-col lg:overflow-visible">
            {visible.map((item) => {
              const active = activeSection === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => requestSection(item.id)}
                  className={`flex shrink-0 items-center gap-3 rounded-xl px-3.5 py-2.5 text-left transition-all ${
                    active
                      ? "bg-[var(--accent-10)] text-[var(--accent)]"
                      : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
                  }`}
                >
                  <item.icon className="h-4.5 w-4.5 shrink-0" />
                  <span className="leading-tight">
                    <span className="block text-sm font-bold">{item.label}</span>
                    <span className="hidden text-[11px] font-medium opacity-70 lg:block">
                      {item.desc}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </nav>

        {/* Active section */}
        <div className="min-w-0 flex-1 space-y-6">
          {activeSection === "account" && (
            <>
              <AccountSection />
              <SecuritySection />
              <SessionsCard />
            </>
          )}
          {activeSection === "branding" && <BrandingSection />}
          {activeSection === "appearance" && <AppearanceSection {...appearance} />}
          {activeSection === "integrations" && (
            <>
              <IntegrationsSection />
              <CloudinarySection />
            </>
          )}
          {activeSection === "email" && <EmailSection />}
          {activeSection === "email-templates" && <EmailTemplatesSection />}
          {activeSection === "categories" && <CategoriesView />}
        </div>
      </div>
    </div>
  );
}
