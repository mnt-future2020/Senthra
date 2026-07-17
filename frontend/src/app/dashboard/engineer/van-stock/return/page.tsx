import { EngineerGuard } from "@/components/dashboard/engineer/EngineerGuard";
import { ReturnComposerPage } from "@/components/dashboard/engineer/VanStockComposer";

export default function NewFieldStockReturnPage() {
  return (
    <EngineerGuard perm="engineer.van_stock.request">
      <ReturnComposerPage />
    </EngineerGuard>
  );
}
