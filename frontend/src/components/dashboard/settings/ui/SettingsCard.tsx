import * as React from "react";

// Section card with a left title/description rail and a right control column.
// The split layout fills wide screens cleanly (GitHub / Stripe settings style)
// and collapses to a single stacked column on small screens.
export function SettingsCard({
  title,
  desc,
  icon: Icon,
  badge,
  children,
}: {
  title: string;
  desc: string;
  icon?: React.ElementType;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className="border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xs md:p-7"
      style={{ borderRadius: "var(--radius)" }}
    >
      <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-10">
        {/* Left rail: icon + title (+ optional badge) + description */}
        <div className="lg:max-w-[260px]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {Icon && (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-10)] text-[var(--accent)]">
                <Icon className="h-5 w-5" />
              </span>
            )}
            <h2 className="text-lg font-extrabold tracking-tight text-[var(--ink)]">
              {title}
            </h2>
            {badge}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">
            {desc}
          </p>
        </div>

        {/* Right column: form controls */}
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}
