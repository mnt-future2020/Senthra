import { AuthGuard } from "@/components/auth/AuthGuard";
import { CustomerFirstLoginGate } from "@/components/customer/CustomerFirstLoginGate";
import { CustomerShell } from "@/components/customer/CustomerShell";

// Shell + gating for every /customer/* route — the read-only customer portal.
// AuthGuard requireType="customer" sends an unauthenticated visitor to /login and
// any non-customer principal back to its own home (so staff/admin never see the
// portal, and a customer never sees the admin dashboard). CustomerFirstLoginGate
// then forces a first-login customer to set their password before the portal shows.
export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard requireType="customer">
      <CustomerFirstLoginGate>
        <CustomerShell>{children}</CustomerShell>
      </CustomerFirstLoginGate>
    </AuthGuard>
  );
}
