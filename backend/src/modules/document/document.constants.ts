// Document Platform — shared constants. Built ONCE; every document type (only purchase_order
// is wired now) shares this geometry/palette so the platform stays consistent and reusable.

// The document types the platform will render. Only "purchase_order" has a builder/renderer today;
// the rest are declared so future modules (Goods In/Out, Delivery Note, Job Pack, Reports) slot in
// as consumers without redefining the type set.
export const DOCUMENT_TYPES = [
  "purchase_order",
  "goods_receipt",
  "goods_dispatch",
  "delivery_note",
  "job_pack",
  "report",
] as const;

// Human label + default filename stem per type.
export const DOCUMENT_LABELS: Record<(typeof DOCUMENT_TYPES)[number], string> = {
  purchase_order: "Purchase Order",
  goods_receipt: "Goods Receipt Note",
  goods_dispatch: "Goods Dispatch Note",
  delivery_note: "Delivery Note",
  job_pack: "Job Pack",
  report: "Report",
};

// A4 page geometry (PDF points; 1pt = 1/72in). Margin is generous so the letterhead breathes.
export const PAGE = { size: "A4" as const, margin: 46, headerHeight: 96 } as const;

// Neutral palette (the brand accent is resolved per-render from Branding.brandColor).
export const COLORS = {
  ink: "#1a1a2e",
  muted: "#5a5a72",
  faint: "#9a9ab0",
  line: "#e2e2ea",
  zebra: "#f6f6fa",
  white: "#ffffff",
} as const;

export const FONT = { title: 19, section: 10.5, label: 8, body: 9.5, small: 8 } as const;
