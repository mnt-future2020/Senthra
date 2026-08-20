"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { RentalItemForm } from "@/components/dashboard/rentals/RentalItemForm";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as rentalService from "@/services/rental.service";
import type { RentalItem } from "@/types/rental";

export default function EditRentalItemPage() {
  const params = useParams();
  const idOrCode = String(params.id);

  return (
    <PermissionGate anyOf={["rentals.edit"]}>
      <EditLoader key={idOrCode} idOrCode={idOrCode} />
    </PermissionGate>
  );
}

function EditLoader({ idOrCode }: { idOrCode: string }) {
  const [item, setItem] = React.useState<RentalItem | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    rentalService
      .getRentalItem(idOrCode)
      .then((it) => {
        if (active) setItem(it);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load this rental item.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [idOrCode]);

  if (loading) return <FormPageSkeleton />;
  if (error || !item) return <FormError message={error ?? "Rental item not found."} />;
  return <RentalItemForm item={item} />;
}
