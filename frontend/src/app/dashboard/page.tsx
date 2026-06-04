import { redirect } from "next/navigation";

// The dashboard has no standalone home screen yet — send visitors (and the
// post-login redirect to /dashboard) straight to Settings. Change the target
// here if a real landing page is added later.
export default function DashboardIndexPage() {
  redirect("/dashboard/settings");
}
