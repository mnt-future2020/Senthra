import { Suspense } from "react";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { GoodsReceiptsView } from "@/components/dashboard/goods-in/GoodsReceiptsView";

export default function GoodsInPage() {
  return (
    <PermissionGate anyOf={["goods_in.view"]}>
      {/* Suspense satisfies useSearchParams (?q, ?status, ?page) during prerender. */}
      <Suspense>
        <GoodsReceiptsView />
      </Suspense>
    </PermissionGate>
  );
}
