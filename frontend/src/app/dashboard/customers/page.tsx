import { Suspense } from "react";

import { CustomersPanel } from "@/components/dashboard/customers/CustomersPanel";
import { PermissionGate } from "@/components/auth/PermissionGate";

export default function CustomersPage() {
  return (
    // categories.view admits the Categories tab on its own: the customer stock-category master
    // lives here now, so a role holding only that permission must still be able to reach it.
    <PermissionGate anyOf={["customers.view", "categories.view"]}>
      {/* Suspense satisfies useSearchParams (the ?tab= seed) during prerender. */}
      <Suspense>
        <CustomersPanel />
      </Suspense>
    </PermissionGate>
  );
}
