import * as React from "react";

// Top-header section card for the My Account surface: an accent icon chip, a
// title + description, an optional right-aligned action, then a full-width body.
// Distinct from the settings left-rail SettingsCard — the account page reads as a
// focused profile + sections layout — but built from the same surface / border /
// radius / accent tokens, so it stays native to the rest of the app.
export function AccountCard({
  icon: Icon,
  title,
  desc,
  action,
  children,
  style,
}: {
  icon: React.ElementType;
  title: string;
  desc?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <section
      className="overflow-hidden border border-[var(--border)] bg-[var(--surface)] shadow-xs"
      style={{ borderRadius: "var(--radius)", ...style }}
    >
      <header className="flex items-start gap-3.5 border-b border-[var(--border-2)] p-5 md:p-6">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-10)] text-[var(--accent)]">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-extrabold tracking-tight text-[var(--ink)]">{title}</h2>
          {desc && <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted)]">{desc}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="p-5 md:p-6">{children}</div>
    </section>
  );
}
