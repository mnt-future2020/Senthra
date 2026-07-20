import * as React from "react";

// Section card with a left title/description rail and a right control column.
// The split layout fills wide screens cleanly (GitHub / Stripe settings style)
// and collapses to a single stacked column on small screens.
//
// The split waits for `xl`, not `lg`: the Settings page already puts its own
// lg:w-60 section nav beside these cards, so splitting off another 260px rail at
// the same breakpoint left the control column ~76px wide at 1024px — labels
// overlapped and every input collapsed to a stub. Stacking until 1280px keeps the
// controls full-width on laptops and restores the two-column look once it fits.
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
      className="border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs sm:p-6 md:p-7"
      style={{ borderRadius: "var(--radius)" }}
    >
      <div className="grid gap-6 xl:grid-cols-[260px_minmax(0,1fr)] xl:gap-10">
        {/* Left rail: icon + title (+ optional badge) + description */}
        <div className="xl:max-w-65">
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
