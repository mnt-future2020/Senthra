import { AuthGuard } from "@/components/auth/AuthGuard";
import { DashboardProvider } from "@/providers/DashboardProvider";
import { DashboardShell } from "@/components/dashboard/shell/DashboardShell";

// Shared shell + state for every /dashboard/* route.
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // AuthGuard (admin-only) wraps the whole shell so neither an unauthenticated
  // visitor nor a staff user ever sees the dashboard chrome — staff are redirected
  // to /portal, unauthenticated visitors to /login.
  return (
    <DashboardProvider>
      <AuthGuard requireType="admin">
        <DashboardShell>{children}</DashboardShell>
      </AuthGuard>
    </DashboardProvider>
  );
}
