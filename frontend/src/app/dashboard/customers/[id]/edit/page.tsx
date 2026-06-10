"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { CustomerForm } from "@/components/dashboard/customers/CustomerForm";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as customerService from "@/services/customer.service";
import type { Customer } from "@/types/customer";

// :id may be a database id OR a customerCode (the list/detail link by code).
export default function EditCustomerPage() {
  const params = useParams();
  const idOrCode = String(params.id);

  // Key the loader by id so navigating directly between two edit URLs (e.g. browser
  // back/forward) remounts it with fresh state — the form can never render the
  // previously-loaded customer under a new URL.
  return (
    <PermissionGate anyOf={["customers.edit"]}>
      <EditCustomerLoader key={idOrCode} idOrCode={idOrCode} />
    </PermissionGate>
  );
}

function EditCustomerLoader({ idOrCode }: { idOrCode: string }) {
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

  if (loading) return <FormPageSkeleton />;
  if (error || !customer) return <FormError message={error ?? "Customer not found."} />;
  return <CustomerForm mode="edit" customer={customer} />;
}
