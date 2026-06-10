"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/useAuth";
import { AccountPanel } from "@/components/account/AccountPanel";
import { CustomerAccountPanel } from "@/components/account/CustomerAccountPanel";

// "My Account" inside the dashboard shell, for a staff user OR a customer (both
// manage their own password + devices here). The super-admin manages its own
// credentials under Settings → Account, so an admin who lands here is redirected
// there. AuthGuard keeps unauthenticated visitors out; this is each principal's own
// account, so it needs no permission gate.
export default function AccountPage() {
  const { admin, customer } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (admin) router.replace("/dashboard/settings");
  }, [admin, router]);

  if (admin) return null;

  return customer ? <CustomerAccountPanel /> : <AccountPanel />;
}
