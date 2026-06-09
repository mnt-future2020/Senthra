"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { UserDetail } from "@/components/dashboard/users-roles/users/UserDetail";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as userService from "@/services/user.service";
import type { User } from "@/types/user";

export default function ViewUserPage() {
  const params = useParams();
  const id = String(params.id);

  const [user, setUser] = React.useState<User | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    userService
      .getUser(id)
      .then((u) => {
        if (active) setUser(u);
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
    <PermissionGate anyOf={["users.view"]}>
      {loading ? (
        <FormPageSkeleton />
      ) : error || !user ? (
        <FormError message={error ?? "User not found."} />
      ) : (
        <UserDetail user={user} />
      )}
    </PermissionGate>
  );
}
