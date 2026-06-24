import { EngineerGuard } from "@/components/dashboard/engineer/EngineerGuard";
import { EngineerDashboard } from "@/components/dashboard/engineer/EngineerDashboard";

export default function EngineerDashboardPage() {
  return (
    <EngineerGuard>
      <EngineerDashboard />
    </EngineerGuard>
  );
}
