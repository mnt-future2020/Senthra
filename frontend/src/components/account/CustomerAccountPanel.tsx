import { PasswordCard } from "./PasswordCard";
import { SessionsCard } from "./SessionsCard";
import { CustomerProfileCard } from "./CustomerProfileCard";

// The customer "My Account" surface (at /dashboard/account): same layout as the
// staff account page — change password + active devices in the main column, and a
// read-only company profile in the sticky aside.
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
          style={{ animationDelay: "140ms", animationFillMode: "backwards" }}
        >
          <CustomerProfileCard />
        </div>
      </aside>
    </div>
  );
}
