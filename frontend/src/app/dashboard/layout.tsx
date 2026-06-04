import { AuthGuard } from "@/components/auth/AuthGuard";
import { DashboardProvider } from "@/providers/DashboardProvider";
import { DashboardShell } from "@/components/dashboard/shell/DashboardShell";

// Shared shell + state for every /dashboard/* route.
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // AuthGuard wraps the whole shell so an unauthenticated visitor never sees the
  // dashboard chrome (sidebar/topbar/nav) flash before being redirected to /login.
  return (
    <DashboardProvider>
      <AuthGuard>
        <DashboardShell>{children}</DashboardShell>
      </AuthGuard>
    </DashboardProvider>
  );
}
