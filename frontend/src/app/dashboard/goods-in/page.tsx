import { PermissionGate } from "@/components/auth/PermissionGate";
import { GoodsReceiptsView } from "@/components/dashboard/goods-in/GoodsReceiptsView";

export default function GoodsInPage() {
  return (
    <PermissionGate anyOf={["goods_in.view"]}>
      <GoodsReceiptsView />
    </PermissionGate>
  );
}
