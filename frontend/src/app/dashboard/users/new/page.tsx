"use client";

import * as React from "react";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { UserForm } from "@/components/dashboard/users-roles/users/UserForm";
import { FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as roleService from "@/services/role.service";
import type { Role } from "@/types/role";

export default function NewUserPage() {
  const [roles, setRoles] = React.useState<Role[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let active = true;
    roleService
      .listRoles()
      .then((r) => {
        if (active) setRoles(r);
      })
      .catch(() => {
        // non-fatal — the role dropdown just stays at "No role"
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <PermissionGate anyOf={["users.create"]}>
      {loading ? <FormPageSkeleton /> : <UserForm mode="create" roles={roles} />}
    </PermissionGate>
  );
}
