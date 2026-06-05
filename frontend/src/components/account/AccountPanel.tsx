import { ProfileCard } from "./ProfileCard";
import { PasswordCard } from "./PasswordCard";
import { SessionsCard } from "./SessionsCard";

// The staff "My Account" surface: read-only profile, change password, and active
// device sessions. Rendered both inside the dashboard shell (for permissioned
// staff, at /dashboard/account) and on the standalone portal home (for staff with
// no dashboard access), so the experience is identical wherever they manage it.
export function AccountPanel() {
  return (
    <div className="space-y-6">
      <ProfileCard />
      <PasswordCard />
      <SessionsCard />
    </div>
  );
}
