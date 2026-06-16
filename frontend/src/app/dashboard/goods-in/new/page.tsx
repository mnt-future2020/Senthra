import { PermissionGate } from "@/components/auth/PermissionGate";
import { GoodsReceiptForm } from "@/components/dashboard/goods-in/GoodsReceiptForm";

export default function NewGoodsReceiptPage() {
  return (
    <PermissionGate anyOf={["goods_in.create"]}>
      <GoodsReceiptForm mode="create" />
    </PermissionGate>
  );
}
