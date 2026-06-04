// Turn a human label into a stable machine key.
// e.g. "Field Engineer" -> "field_engineer", "Customer PM" -> "customer_pm".
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
