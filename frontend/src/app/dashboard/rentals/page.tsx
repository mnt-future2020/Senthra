import { redirect } from "next/navigation";

// Rentals lives in the Inventory Hub (Inventory → Rentals), so the standalone page is retired —
// same treatment the IRM catalogue gets. The route stays as a redirect so old links and bookmarks
// land in the Hub. The item sub-routes (/new, /[id], /[id]/edit) remain: the embedded catalogue
// links to them.
export default function RentalsPage() {
  redirect("/dashboard/inventory?tab=rental&rental=catalogue");
}
