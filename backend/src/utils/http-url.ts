/**
 * Is this string a link a browser can safely be handed as an `href`?
 *
 * The question is the SCHEME, not the shape. `new URL()` — which is what a plain "is it a URL"
 * check reduces to — happily accepts `javascript:alert(1)` and `data:text/html,…`: both are
 * perfectly well-formed URLs, and both execute when clicked. So validating that a string parses
 * as a URL rejects nothing that matters. Only an allow-list of schemes does.
 *
 * Used for job attachments, which are typed in as free text by staff and rendered as links — now
 * on the CUSTOMER portal as well as the office page, which is what makes the scheme worth pinning.
 */
export function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    // Not a URL at all (a filename, a note someone typed in the wrong box). Relative paths land
    // here too, and that is right: an attachment must say where it lives.
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * Keep only the links that are safe to render, dropping the rest silently.
 *
 * For READ paths, where validation is not an option: rows written before the rule existed are
 * already stored, and someone opening a job is not the moment to surface a data-entry problem from
 * months ago. Dropping shows them every attachment we can vouch for and none we can't.
 *
 * Applied on BOTH job read paths — `toPublic` (office) and `getJobForCustomer` (portal). Filtering
 * only the portal would leave the surface staff click far more often as the unguarded one, which is
 * backwards. Keep them together if a third read path appears.
 */
export function safeHttpUrls(values: string[] | null | undefined): string[] {
  return (values ?? []).filter(isHttpUrl);
}
