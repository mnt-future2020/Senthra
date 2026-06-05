"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { RoleForm } from "@/components/dashboard/users/RoleForm";
import { FormError, FormPageSkeleton } from "@/components/dashboard/users/FormScaffold";
import * as roleService from "@/services/role.service";
import type { Role } from "@/types/role";

export default function EditRolePage() {
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
    <PermissionGate anyOf={["roles.edit"]}>
      {loading ? (
        <FormPageSkeleton />
      ) : error || !role ? (
        <FormError message={error ?? "Role not found."} />
      ) : (
        <RoleForm mode="edit" role={role} />
      )}
    </PermissionGate>
  );
}
