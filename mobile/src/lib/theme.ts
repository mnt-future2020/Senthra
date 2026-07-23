// Senthra brand palette — matches the web dashboard's default accent (#7b6ef0).

export const colors = {
  accent: "#7b6ef0",
  accentSoft: "#efedfd",
  bg: "#f5f5f7",
  card: "#ffffff",
  text: "#17171c",
  muted: "#6b7280",
  faint: "#9ca3af",
  border: "#e5e7eb",
  danger: "#dc2626",
  dangerSoft: "#fee2e2",
  success: "#16a34a",
  successSoft: "#dcfce7",
  warn: "#d97706",
  warnSoft: "#fef3c7",
  info: "#2563eb",
  infoSoft: "#dbeafe",
  mutedSoft: "#f3f4f6",
} as const;

export type Tone = "accent" | "success" | "warn" | "danger" | "info" | "muted";

const STATUS_TONES: Record<string, Tone> = {
  // shared
  pending: "warn",
  approved: "info",
  declined: "danger",
  cancelled: "muted",
  completed: "success",
  draft: "muted",
  // jobs
  assigned: "info",
  accepted: "accent",
  in_progress: "accent",
  rejected: "danger",
  // goods status
  not_issued: "muted",
  partially_issued: "warn",
  issued: "info",
  awaiting_return: "warn",
  reconciled: "success",
  // van stock
  partially_fulfilled: "accent",
  fulfilled: "success",
  // priority
  low: "muted",
  normal: "info",
  high: "warn",
  urgent: "danger",
};

export function statusTone(status: string): Tone {
  return STATUS_TONES[status] ?? "muted";
}

export function toneColors(tone: Tone): { bg: string; fg: string } {
  switch (tone) {
    case "accent":
      return { bg: colors.accentSoft, fg: colors.accent };
    case "success":
      return { bg: colors.successSoft, fg: colors.success };
    case "warn":
      return { bg: colors.warnSoft, fg: colors.warn };
    case "danger":
      return { bg: colors.dangerSoft, fg: colors.danger };
    case "info":
      return { bg: colors.infoSoft, fg: colors.info };
    default:
      return { bg: colors.mutedSoft, fg: colors.muted };
  }
}
