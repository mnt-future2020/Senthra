import { redirect } from "next/navigation";

// The customer portal has no index screen of its own — the only page is the stock
// view. Redirect the bare /customer segment there so a bookmark or typed URL lands
// correctly instead of 404-ing inside the portal subtree. (homeFor always routes
// customers to /customer/stock, so this only catches the bare path.)
export default function CustomerIndexPage() {
  redirect("/customer/stock");
}
