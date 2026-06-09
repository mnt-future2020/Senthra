"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { CustomerDetail } from "@/components/dashboard/customers/CustomerDetail";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as customerService from "@/services/customer.service";
import type { Customer } from "@/types/customer";

// Resolves :id which may be a database id OR a customerCode (the list links by code).
export default function ViewCustomerPage() {
  const params = useParams();
  const idOrCode = String(params.id);

  const [customer, setCustomer] = React.useState<Customer | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    customerService
      .getCustomer(idOrCode)
      .then((c) => {
        if (active) setCustomer(c);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load this customer.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [idOrCode]);

  return (
    <PermissionGate anyOf={["customers.view"]}>
      {loading ? (
        <FormPageSkeleton />
      ) : error || !customer ? (
        <FormError message={error ?? "Customer not found."} />
      ) : (
        <CustomerDetail initial={customer} />
      )}
    </PermissionGate>
  );
}
