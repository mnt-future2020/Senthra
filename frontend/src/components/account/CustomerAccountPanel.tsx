import { PasswordCard } from "./PasswordCard";
import { SessionsCard } from "./SessionsCard";
import { CustomerProfileCard } from "./CustomerProfileCard";

// The customer "Settings" surface (at /dashboard/account): change password + active devices in the
// main column, and a read-only company profile in the sticky aside.
//
// There is no "Notification preferences" card. One existed as a "coming soon" placeholder, but unlike
// the other placeholders removed alongside it there was nothing behind this one to connect: the
// `notification` module is push DELIVERY only (register/unregister a device token, then `notify`) —
// no preference model, no per-user setting, nowhere to store a choice. The card promised a control
// the customer could never be given, so it went rather than being wired to nothing.
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
