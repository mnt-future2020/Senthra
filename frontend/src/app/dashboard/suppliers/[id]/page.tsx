"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { SupplierDetail } from "@/components/dashboard/suppliers/SupplierDetail";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as supplierService from "@/services/supplier.service";
import type { Supplier } from "@/types/supplier";

// :id may be a database id OR a supplier code (the list links by code).
export default function ViewSupplierPage() {
  const params = useParams();
  const idOrCode = String(params.id);

  return (
    <PermissionGate anyOf={["suppliers.view"]}>
      <SupplierLoader key={idOrCode} idOrCode={idOrCode} />
    </PermissionGate>
  );
}

function SupplierLoader({ idOrCode }: { idOrCode: string }) {
  const [supplier, setSupplier] = React.useState<Supplier | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    supplierService
      .getSupplier(idOrCode)
      .then((s) => {
        if (active) setSupplier(s);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load this supplier.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [idOrCode]);

  if (loading) return <FormPageSkeleton />;
  if (error || !supplier) return <FormError message={error ?? "Supplier not found."} />;
  return <SupplierDetail initial={supplier} />;
}
