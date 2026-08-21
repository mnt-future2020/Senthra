"use client";

import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { HireMovementForm } from "@/components/dashboard/rentals/HireMovementForm";
import { HIRE_FLOOR_PERMISSIONS } from "@/components/dashboard/rentals/hireActions";

// Reporting damage found while hired kit is WITH US — the third leg, and the one that moves nothing.
//
// It exists because the other two only fire at the ends of a hire, and a six-week hire breaks in the
// middle of one. Recorded when it happens, with a photograph, it is evidence; the same fact typed into
// a return note six weeks later is our word against the supplier's.
export default function ReportHireDamagePage() {
  const params = useParams();
  const poId = String(params.poId);
  return (
    <PermissionGate anyOf={HIRE_FLOOR_PERMISSIONS}>
      <HireMovementForm key={poId} poId={poId} direction="damage" />
    </PermissionGate>
  );
}
