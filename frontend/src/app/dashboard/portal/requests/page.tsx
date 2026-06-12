import { CustomerGuard } from "@/components/dashboard/portal/CustomerGuard";
import { StockRequestsView } from "@/components/dashboard/portal/StockRequestsView";

// Customer portal — Stock Requests (the customer's order asks + their status).
export default function PortalRequestsPage() {
  return (
    <CustomerGuard>
      <StockRequestsView />
    </CustomerGuard>
  );
}
