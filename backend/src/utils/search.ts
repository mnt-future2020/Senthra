// Escape regex metacharacters so a user-supplied search term is matched LITERALLY.
//
// Prisma's MongoDB connector compiles `contains` / `startsWith` / `endsWith` straight into a
// `$regularExpression` WITHOUT escaping the term. Passing a raw term therefore (a) THROWS an
// invalid-regex error — Prisma `P2010`, which our error middleware surfaces as a 500 — for inputs
// like "(" or "[", and (b) silently matches the wrong rows for metacharacters like "." "*" "+" "^"
// "|" (e.g. ".*" matches everything). Escaping first makes the term a plain substring match, which
// is what a search box is expected to do. `mode: "insensitive"` is unaffected — only the term's
// content is escaped.
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
