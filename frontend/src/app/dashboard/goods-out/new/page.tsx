import { PermissionGate } from "@/components/auth/PermissionGate";
import { GoodsOutForm } from "@/components/dashboard/goods-out/GoodsOutForm";

export default function NewGoodsOutPage() {
  return (
    <PermissionGate anyOf={["goods_out.create"]}>
      <GoodsOutForm mode="create" />
    </PermissionGate>
  );
}
