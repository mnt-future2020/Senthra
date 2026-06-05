import { AuthGuard } from "@/components/auth/AuthGuard";

// Staff workspace shell. AuthGuard (user-only) keeps the super-admin out (sent to
// /dashboard) and unauthenticated visitors to /login.
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <AuthGuard requireType="user">{children}</AuthGuard>;
}
