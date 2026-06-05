"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/useAuth";
import { AccountPanel } from "@/components/account/AccountPanel";

// "My Account" for a staff user, rendered inside the dashboard shell. The
// super-admin account manages its own email/password under Settings → Account, so
// an admin who lands here is redirected there. AuthGuard (in the dashboard layout)
// keeps unauthenticated visitors out; this page is intentionally open to ANY staff
// user (it's their own account), so it needs no permission gate.
export default function AccountPage() {
  const { admin } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (admin) router.replace("/dashboard/settings");
  }, [admin, router]);

  if (admin) return null;

  return <AccountPanel />;
}
