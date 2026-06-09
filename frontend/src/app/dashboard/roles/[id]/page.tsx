"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { RoleDetail } from "@/components/dashboard/users-roles/roles/RoleDetail";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as roleService from "@/services/role.service";
import type { Role } from "@/types/role";

export default function ViewRolePage() {
  const params = useParams();
  const id = String(params.id);

  const [role, setRole] = React.useState<Role | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    roleService
      .getRole(id)
      .then((r) => {
        if (active) setRole(r);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load this role.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <PermissionGate anyOf={["roles.view"]}>
      {loading ? (
        <FormPageSkeleton />
      ) : error || !role ? (
        <FormError message={error ?? "Role not found."} />
      ) : (
        <RoleDetail role={role} />
      )}
    </PermissionGate>
  );
}
