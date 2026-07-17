import { EngineerGuard } from "@/components/dashboard/engineer/EngineerGuard";
import { EngineerVanStock } from "@/components/dashboard/engineer/EngineerVanStock";

export default function EngineerVanStockPage() {
  return (
    <EngineerGuard perm="engineer.van_stock.request">
      <EngineerVanStock />
    </EngineerGuard>
  );
}
