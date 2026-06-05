import { UsersRolesPanel } from "@/components/dashboard/users/UsersRolesPanel";
import { PermissionGate } from "@/components/auth/PermissionGate";

export default function UsersPage() {
  return (
    <PermissionGate anyOf={["users.manage"]}>
      <UsersRolesPanel />
    </PermissionGate>
  );
}
