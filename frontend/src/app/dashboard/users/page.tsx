import { Suspense } from "react";

import { UsersRolesPanel } from "@/components/dashboard/users-roles/UsersRolesPanel";
import { PermissionGate } from "@/components/auth/PermissionGate";

export default function UsersPage() {
  return (
    <PermissionGate anyOf={["users.view", "roles.view"]}>
      {/* Suspense satisfies useSearchParams (the ?tab= seed) during prerender. */}
      <Suspense>
        <UsersRolesPanel />
      </Suspense>
    </PermissionGate>
  );
}
