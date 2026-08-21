"use client";

import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { HireMovementForm } from "@/components/dashboard/rentals/HireMovementForm";
import { HIRE_FLOOR_PERMISSIONS } from "@/components/dashboard/rentals/hireActions";

// Receiving HIRED kit. Under /rentals, not /goods-in: a goods receipt writes an inventory balance and
// a stock movement, and hired equipment stays the supplier's — the boundary the backend enforces at
// build time (modules/__tests__/rental.boundary.test.ts).
//
// `poId` may be an id OR a purchase-order code; the service resolves either.
export default function ReceiveHirePage() {
  const params = useParams();
  const poId = String(params.poId);
  return (
    // Either hire-floor key: booking equipment in is the warehouse's work, and `manage` is a superset —
    // the same pair every /rental-receipts write route accepts.
    <PermissionGate anyOf={HIRE_FLOOR_PERMISSIONS}>
      <HireMovementForm key={poId} poId={poId} direction="in" />
    </PermissionGate>
  );
}
