// Shared Incoterm options — the single source of truth for the "practical UK set" of
// delivery terms, mirroring the backend contract. Used by both the Purchase Order and
// Purchase Request forms/detail pages so the FE and BE stay in lockstep.
// `value` is the Incoterm code sent on the wire; `label` is the resolved display label.

export interface IncotermOption {
  value: string;
  label: string;
}

export const INCOTERM_OPTIONS: IncotermOption[] = [
  { value: "DDP", label: "DDP — Delivered Duty Paid" },
  { value: "DAP", label: "DAP — Delivered at Place" },
  { value: "DPU", label: "DPU — Delivered at Place Unloaded" },
  { value: "FCA", label: "FCA — Free Carrier" },
  { value: "CPT", label: "CPT — Carriage Paid To" },
  { value: "CIP", label: "CIP — Carriage and Insurance Paid To" },
  { value: "EXW", label: "EXW — Ex Works" },
];

// Resolve an Incoterm code to its full label. Falls back to the raw code for an unknown
// value and to an em dash when none is set.
export function incotermLabel(code?: string | null): string {
  if (!code) return "—";
  return INCOTERM_OPTIONS.find((o) => o.value === code)?.label ?? code;
}
