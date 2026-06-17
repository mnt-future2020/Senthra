import { PermissionGate } from "@/components/auth/PermissionGate";
import { GoodsOutView } from "@/components/dashboard/goods-out/GoodsOutView";

export default function GoodsOutPage() {
  return (
    <PermissionGate anyOf={["goods_out.view"]}>
      <GoodsOutView />
    </PermissionGate>
  );
}
