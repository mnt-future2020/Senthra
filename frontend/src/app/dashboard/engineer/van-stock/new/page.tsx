import { EngineerGuard } from "@/components/dashboard/engineer/EngineerGuard";
import { RestockComposerPage } from "@/components/dashboard/engineer/VanStockComposer";

export default function NewFieldStockRequestPage() {
  return (
    <EngineerGuard perm="engineer.van_stock.request">
      <RestockComposerPage />
    </EngineerGuard>
  );
}
