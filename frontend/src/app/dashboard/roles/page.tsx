import { redirect } from "next/navigation";

// Roles live under the "Users & Roles" page (Roles tab). The /dashboard/roles/*
// routes are just the role form pages, so a bare /dashboard/roles forwards to the
// list rather than 404-ing.
export default function RolesIndexPage() {
  redirect("/dashboard/users?tab=roles");
}
