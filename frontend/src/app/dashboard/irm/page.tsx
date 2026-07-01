import { redirect } from "next/navigation";

// The IRM Catalogue is now part of the Inventory Hub (Inventory → IRM tab → Catalogue), so the
// standalone page is retired. The route is kept as a redirect so old links/bookmarks land in the
// Hub. The item sub-routes (/new, /[id], /[id]/edit) remain — they're used by the embedded catalogue.
export default function IrmPage() {
  redirect("/dashboard/inventory?tab=company&irm=catalogue");
}
