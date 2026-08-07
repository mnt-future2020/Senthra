"use client";

import { useParams } from "next/navigation";

import { CustomerGuard } from "@/components/dashboard/portal/CustomerGuard";
import { PortalJobDetail } from "@/components/dashboard/portal/PortalJobDetail";

// Customer portal — one job. Mirrors the office (/dashboard/jobs/[id]) and engineer
// (/dashboard/engineer/jobs/[id]) detail routes; the server scopes it to the signed-in customer.
export default function PortalJobDetailPage() {
  const params = useParams();
  const id = String(params.id);
  // `key` remounts on an id change so the previous job's state can't show under the new one's URL.
  return (
    <CustomerGuard>
      <PortalJobDetail key={id} id={id} />
    </CustomerGuard>
  );
}
