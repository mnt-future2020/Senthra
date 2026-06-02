import { AuthGuard } from "@/components/auth/AuthGuard";
import { DashboardProvider } from "@/components/dashboard/DashboardProvider";
import { DashboardShell } from "@/components/dashboard/shell/DashboardShell";

// Shared shell + state for every /dashboard/* route.
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <DashboardProvider>
        <DashboardShell>{children}</DashboardShell>
      </DashboardProvider>
    </AuthGuard>
  );
}
