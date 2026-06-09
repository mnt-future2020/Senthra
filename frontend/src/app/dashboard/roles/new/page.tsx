"use client";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { RoleForm } from "@/components/dashboard/users-roles/roles/RoleForm";

export default function NewRolePage() {
  return (
    <PermissionGate anyOf={["roles.create"]}>
      <RoleForm mode="create" />
    </PermissionGate>
  );
}
