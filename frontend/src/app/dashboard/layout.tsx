import { AuthGuard } from "@/components/auth/AuthGuard";
import { DashboardProvider } from "@/providers/DashboardProvider";
import { DashboardShell } from "@/components/dashboard/shell/DashboardShell";

// Shared shell + state for every /dashboard/* route.
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // AuthGuard (dashboard access) wraps the whole shell: the super-admin and any
  // staff user holding a dashboard permission get in; permission-less staff are
  // redirected to /portal and unauthenticated visitors to /login — so the chrome
  // never flashes to someone who shouldn't see it.
  return (
    <DashboardProvider>
      <AuthGuard requireDashboard>
        <DashboardShell>{children}</DashboardShell>
      </AuthGuard>
    </DashboardProvider>
  );
}
