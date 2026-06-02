"use client";

import * as React from "react";
import { ShieldCheck, Palette, Plug, Mail } from "lucide-react";

import { AccountSection } from "./AccountSection";
import { SecuritySection } from "./SecuritySection";
import { AppearanceSection } from "./AppearanceSection";
import { IntegrationsSection } from "./IntegrationsSection";
import { EmailSection } from "./EmailSection";
import type { AppearanceProps, Section } from "./types";

const NAV: {
  id: Section;
  label: string;
  icon: React.ElementType;
  desc: string;
}[] = [
  {
    id: "account",
    label: "Account & Security",
    icon: ShieldCheck,
    desc: "Email & password",
  },
  { id: "appearance", label: "Appearance", icon: Palette, desc: "Theme & layout" },
  { id: "integrations", label: "Integrations", icon: Plug, desc: "Google Sign-In" },
  { id: "email", label: "Email", icon: Mail, desc: "SMTP & delivery" },
];

export function SettingsPanel(appearance: AppearanceProps) {
  const [section, setSection] = React.useState<Section>("account");

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
            {NAV.map((item) => {
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setSection(item.id)}
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
          {section === "account" && (
            <>
              <AccountSection />
              <SecuritySection />
            </>
          )}
          {section === "appearance" && <AppearanceSection {...appearance} />}
          {section === "integrations" && <IntegrationsSection />}
          {section === "email" && <EmailSection />}
        </div>
      </div>
    </div>
  );
}
