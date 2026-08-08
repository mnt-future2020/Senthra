// The two URL decisions behind an attention chip, kept as pure functions so they can be tested
// without a router. Both changed when catalog items stopped being guaranteed to have an href, and
// both fail silently in the browser: a chip that never lights up, or one that clears the wrong params.

/**
 * Is the screen already showing exactly this chip's rows?
 *
 * Three ways to be false, and each matters:
 *   • NO HREF — the count has no screen at all (an aggregate worked inside each record). It can never
 *     be "the current view", and treating a missing href as a match would light up a chip that does
 *     nothing when pressed.
 *   • no query — a bare route would match vacuously and light up every chip on its own page.
 *   • a different path, or any param not currently applied.
 *
 * Extra params on the URL (search, page, sort) do NOT prevent a match: the chip claims its own
 * filters, not the whole address bar.
 */
export function isChipActive(
  href: string | undefined,
  pathname: string,
  current: { get: (key: string) => string | null },
): boolean {
  if (!href) return false;
  const [path, query] = href.split("?");
  if (!query || path !== pathname) return false;
  return [...new URLSearchParams(query).entries()].every(([k, v]) => current.get(k) === v);
}

/**
 * The query string left after un-applying a chip's filter.
 *
 * Removes only the params the chip itself set and leaves everything else alone — the user asked to
 * stop narrowing, not to reset the screen. `page` goes too: a narrower list has fewer pages, so
 * page 4 of the filter that was just cleared is a dead end.
 */
export function clearedQuery(href: string | undefined, current: URLSearchParams): string {
  const query = href?.split("?")[1] ?? "";
  const next = new URLSearchParams(current.toString());
  for (const key of new URLSearchParams(query).keys()) next.delete(key);
  next.delete("page");
  return next.toString();
}
