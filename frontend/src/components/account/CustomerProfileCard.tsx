"use client";

import * as React from "react";
import { Briefcase, Globe, Mail, Phone, User as UserIcon } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { useAuth } from "@/hooks/useAuth";
import { Avatar } from "@/components/ui/Avatar";
import type { CustomerSelfProfile } from "@/types/customer";

// Read-only company profile for the signed-in customer, sized for the account
// page's sticky aside. The principal carries name/code/email/logo; the rest
// (contact, phone, website) is fetched from /customer/me. All managed by the
// account manager — no self-service edit by design.
export function CustomerProfileCard({ style }: { style?: React.CSSProperties }) {
  const { customer } = useAuth();
  const [profile, setProfile] = React.useState<CustomerSelfProfile | null>(null);

  React.useEffect(() => {
    let active = true;
    customerService
      .getOwnProfile()
      .then((p) => {
        if (active) setProfile(p);
      })
      .catch(() => {
        // non-fatal — the principal already covers name/code/email
      });
    return () => {
      active = false;
    };
  }, []);

  if (!customer) return null;

  const websiteHref = profile?.website
    ? profile.website.startsWith("http")
      ? profile.website
      : `https://${profile.website}`
    : null;

  return (
    <section
      className="border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xs"
      style={{ borderRadius: "var(--radius)", ...style }}
    >
      <div className="text-center">
        <div className="flex justify-center">
          <Avatar url={customer.logoUrl} firstName={customer.name || "?"} lastName="" size={80} />
        </div>

        <h1 className="mt-3 truncate text-lg font-extrabold tracking-tight text-[var(--ink)]">
          {customer.name}
        </h1>
        <p className="truncate font-mono text-xs text-[var(--muted)]">{customer.customerCode}</p>

        <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1 text-[11px] font-extrabold uppercase tracking-wider text-[var(--muted)]">
          Customer · read-only
        </span>

        <dl className="mt-5 space-y-3 text-left">
          <Tile icon={<Mail className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />} label="Login email" value={customer.email} />
          {profile?.contactPerson && (
            <Tile
              icon={<UserIcon className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />}
              label="Contact person"
              value={profile.contactPerson}
            />
          )}
          {profile?.contactJobTitle && (
            <Tile
              icon={<Briefcase className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />}
              label="Job title"
              value={profile.contactJobTitle}
            />
          )}
          {profile?.phone && (
            <Tile icon={<Phone className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />} label="Phone" value={profile.phone} />
          )}
          {websiteHref && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
              <dt className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Website</dt>
              <dd className="mt-1 flex items-center gap-1.5 truncate text-sm font-bold text-[var(--ink)]">
                <Globe className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                <a href={websiteHref} target="_blank" rel="noopener noreferrer" className="truncate hover:opacity-80">
                  {profile?.website}
                </a>
              </dd>
            </div>
          )}
        </dl>

        <p className="mt-4 text-[11px] leading-relaxed text-[var(--faint)]">
          Your company details are managed by your account manager. Ask them if anything looks wrong.
        </p>
      </div>
    </section>
  );
}

function Tile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
      <dt className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</dt>
      <dd className="mt-1 flex items-center gap-1.5 truncate text-sm font-bold text-[var(--ink)]">
        {icon}
        {value}
      </dd>
    </div>
  );
}
