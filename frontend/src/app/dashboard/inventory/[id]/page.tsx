"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { InventoryDetail } from "@/components/dashboard/inventory/InventoryDetail";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as inventoryService from "@/services/inventory.service";
import type { InventoryDetail as InventoryDetailType } from "@/types/inventory";

// :id is an InventoryBalance id (the list links by id).
export default function ViewInventoryPage() {
  const params = useParams();
  const id = String(params.id);

  return (
    <PermissionGate anyOf={["inventory.view"]}>
      <Loader key={id} id={id} />
    </PermissionGate>
  );
}

function Loader({ id }: { id: string }) {
  const [inv, setInv] = React.useState<InventoryDetailType | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    inventoryService
      .getInventory(id)
      .then((i) => active && setInv(i))
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load this inventory record."))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [id]);

  if (loading) return <FormPageSkeleton />;
  if (error || !inv) return <FormError message={error ?? "Inventory record not found."} />;
  return <InventoryDetail initial={inv} />;
}
