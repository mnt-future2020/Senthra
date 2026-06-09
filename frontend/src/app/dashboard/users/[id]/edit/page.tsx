"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { UserForm } from "@/components/dashboard/users-roles/users/UserForm";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as roleService from "@/services/role.service";
import * as userService from "@/services/user.service";
import type { Role } from "@/types/role";
import type { User } from "@/types/user";

export default function EditUserPage() {
  const params = useParams();
  const id = String(params.id);

  const [user, setUser] = React.useState<User | null>(null);
  const [roles, setRoles] = React.useState<Role[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    Promise.all([userService.getUser(id), roleService.listRoles()])
      .then(([u, r]) => {
        if (!active) return;
        setUser(u);
        setRoles(r);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load this user.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <PermissionGate anyOf={["users.edit"]}>
      {loading ? (
        <FormPageSkeleton />
      ) : error || !user ? (
        <FormError message={error ?? "User not found."} />
      ) : (
        <UserForm mode="edit" user={user} roles={roles} />
      )}
    </PermissionGate>
  );
}
