import { Check, AlertCircle, AlertTriangle } from "lucide-react";

import type { Msg } from "./types";
import { NOTICE_SIZE_CLS, NOTICE_TONE_CLS, type NoticeSize, type NoticeType } from "./noticeTone";

const ICONS: Record<NoticeType, typeof Check> = {
  success: Check,
  warn: AlertTriangle,
  error: AlertCircle,
};

const ICON_SIZE: Record<NoticeSize, string> = {
  xs: "h-3 w-3",
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
};

// Inline feedback banner used by every settings form.
//
// Keyed off the message type rather than a `success ? green : red` boolean — that boolean is what
// made a non-blocking advisory render identically to a hard failure, and it would have kept doing so
// after "warn" joined the union, since a boolean check still compiles. Every lookup here is an
// exhaustive Record, so a new tier or size is a type error until it's given a style.
//
// `size` defaults to the form-level "md" so the existing call sites are untouched; pass "sm" when the
// notice is a footnote against something else on the page rather than the answer to a submit.
//
// items-start + a non-shrinking icon: these messages wrap to two or three lines (a duplicate warning
// lists every clashing item), and centring left the icon floating in the middle of the block.
export function Notice({ msg, size = "md" }: { msg: Msg; size?: NoticeSize }) {
  if (!msg) return null;
  const Icon = ICONS[msg.type];
  return (
    <div
      className={`flex items-start font-semibold ${NOTICE_SIZE_CLS[size]} ${NOTICE_TONE_CLS[msg.type]}`}
      role={msg.type === "error" ? "alert" : "status"}
    >
      <Icon className={`mt-px shrink-0 ${ICON_SIZE[size]}`} />
      <span className="min-w-0 leading-snug">{msg.text}</span>
    </div>
  );
}
