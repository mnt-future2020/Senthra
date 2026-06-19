"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { AddStockEntryPage } from "@/components/dashboard/customers/AddStockEntryPage";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as customerService from "@/services/customer.service";

export default function AddStockEntryRoute() {
  const params = useParams();
  const idOrCode = String(params.id);

  const [customer, setCustomer] = React.useState<{ id: string; name: string; customerCode: string } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    customerService
      .getCustomer(idOrCode)
      .then((c) => {
        if (active) setCustomer({ id: c.id, name: c.name, customerCode: c.customerCode });
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load customer.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [idOrCode]);

  return (
    <PermissionGate anyOf={["customer_stock.create"]}>
      {loading ? (
        <FormPageSkeleton />
      ) : error || !customer ? (
        <FormError message={error ?? "Customer not found."} />
      ) : (
        <AddStockEntryPage customer={customer} />
      )}
    </PermissionGate>
  );
}
