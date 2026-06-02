import { redirect } from "next/navigation";

// The app opens straight into the dashboard.
export default function Home() {
  redirect("/dashboard");
}
