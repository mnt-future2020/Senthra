"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { IrmItemForm } from "@/components/dashboard/irm/IrmItemForm";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as irmService from "@/services/irm.service";
import type { IrmItem } from "@/types/irm";

// :id may be a database id OR an IRM code (the list/detail link by code).
export default function EditIrmItemPage() {
  const params = useParams();
  const idOrCode = String(params.id);

  return (
    <PermissionGate anyOf={["irm.edit"]}>
      <EditIrmLoader key={idOrCode} idOrCode={idOrCode} />
    </PermissionGate>
  );
}

function EditIrmLoader({ idOrCode }: { idOrCode: string }) {
  const [item, setItem] = React.useState<IrmItem | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    irmService
      .getIrmItem(idOrCode)
      .then((it) => {
        if (active) setItem(it);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load this item.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [idOrCode]);

  if (loading) return <FormPageSkeleton />;
  if (error || !item) return <FormError message={error ?? "Item not found."} />;
  return <IrmItemForm mode="edit" item={item} />;
}
