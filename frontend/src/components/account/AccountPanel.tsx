import { ProfileCard } from "./ProfileCard";
import { ProfileEditCard } from "./ProfileEditCard";
import { PasswordCard } from "./PasswordCard";
import { SessionsCard } from "./SessionsCard";
import { SignatureCard } from "./SignatureCard";

// The staff "My Account" surface (at /dashboard/account): a full-width two-column
// layout matching the rest of the app — the actionable cards (change password,
// active devices) in the main column, and a read-only profile summary in a sticky
// aside. Each card fades in with a small stagger (animationFillMode: backwards holds
// it hidden through its delay so there's no pre-animation flash).
export function AccountPanel() {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <div className="anim-fade-in" style={{ animationFillMode: "backwards" }}>
          <ProfileEditCard />
        </div>
        <div
          className="anim-fade-in"
          style={{ animationDelay: "70ms", animationFillMode: "backwards" }}
        >
          <PasswordCard />
        </div>
        <div
          className="anim-fade-in"
          style={{ animationDelay: "140ms", animationFillMode: "backwards" }}
        >
          <SignatureCard />
        </div>
        <div
          className="anim-fade-in"
          style={{ animationDelay: "210ms", animationFillMode: "backwards" }}
        >
          <SessionsCard />
        </div>
      </div>
      <aside className="lg:sticky lg:top-6 lg:self-start">
        <div
          className="anim-fade-in"
          style={{ animationDelay: "280ms", animationFillMode: "backwards" }}
        >
          <ProfileCard />
        </div>
      </aside>
    </div>
  );
}
