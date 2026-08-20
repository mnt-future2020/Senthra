"use client";

import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { HireMovementForm } from "@/components/dashboard/rentals/HireMovementForm";

// Handing hired kit BACK. The same screen as receiving, in the other direction — see HireMovementForm
// for why that is one component and not two.
//
// A page rather than a modal, because the record it writes is the same weight as the delivery's: a
// date, a collector, a condition, per-line quantities, asset tags and photographs. That is not a
// confirm dialog. The one-click "mark returned" still exists on the order for a hire that simply ended.
export default function ReturnHirePage() {
  const params = useParams();
  const poId = String(params.poId);
  return (
    <PermissionGate anyOf={["rentals.hire.receive", "rentals.hire.manage"]}>
      <HireMovementForm key={poId} poId={poId} direction="out" />
    </PermissionGate>
  );
}
