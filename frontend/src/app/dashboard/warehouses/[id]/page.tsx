"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { WarehouseDetail } from "@/components/dashboard/warehouses/WarehouseDetail";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as warehouseService from "@/services/warehouse.service";
import type { Warehouse } from "@/types/warehouse";

// :id may be a database id OR a warehouse code (the list links by code).
export default function ViewWarehousePage() {
  const params = useParams();
  const idOrCode = String(params.id);

  return (
    <PermissionGate anyOf={["warehouse.view"]}>
      <WarehouseLoader key={idOrCode} idOrCode={idOrCode} />
    </PermissionGate>
  );
}

function WarehouseLoader({ idOrCode }: { idOrCode: string }) {
  const [warehouse, setWarehouse] = React.useState<Warehouse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    warehouseService
      .getWarehouse(idOrCode)
      .then((w) => {
        if (active) setWarehouse(w);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load this warehouse.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [idOrCode]);

  if (loading) return <FormPageSkeleton />;
  if (error || !warehouse) return <FormError message={error ?? "Warehouse not found."} />;
  return <WarehouseDetail initial={warehouse} />;
}
