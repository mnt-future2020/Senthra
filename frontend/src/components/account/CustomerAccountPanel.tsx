import { Bell } from "lucide-react";

import { PasswordCard } from "./PasswordCard";
import { SessionsCard } from "./SessionsCard";
import { CustomerProfileCard } from "./CustomerProfileCard";
import { AccountCard } from "./AccountCard";

// Hidden for client demo — flip to false after launch to show the "coming soon" card.
const DEMO_HIDE_COMING_SOON = true;

// The customer "Settings" surface (at /dashboard/account): change password + active
// devices + a notifications placeholder in the main column, and a read-only company
// profile in the sticky aside. Notification preferences ship as an honest "coming
// soon" until the notifications module exists.
export function CustomerAccountPanel() {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <div className="anim-fade-in" style={{ animationFillMode: "backwards" }}>
          <PasswordCard />
        </div>
        <div
          className="anim-fade-in"
          style={{ animationDelay: "70ms", animationFillMode: "backwards" }}
        >
          <SessionsCard />
        </div>
        {!DEMO_HIDE_COMING_SOON && (
          <div
            className="anim-fade-in"
            style={{ animationDelay: "140ms", animationFillMode: "backwards" }}
          >
            <AccountCard
              icon={Bell}
              title="Notification preferences"
              desc="Choose what you get notified about — request updates, deliveries and more."
            >
              <div className="flex items-center gap-3 rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)]/40 px-4 py-3">
                <span className="rounded-full bg-[var(--surface-2)] px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
                  Coming soon
                </span>
                <p className="text-xs text-[var(--muted)]">
                  Notification settings will be available here once the notifications module is ready.
                </p>
              </div>
            </AccountCard>
          </div>
        )}
      </div>
      <aside className="lg:sticky lg:top-6 lg:self-start">
        <div
          className="anim-fade-in"
          style={{ animationDelay: "210ms", animationFillMode: "backwards" }}
        >
          <CustomerProfileCard />
        </div>
      </aside>
    </div>
  );
}
