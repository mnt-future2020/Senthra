import { Check, AlertCircle } from "lucide-react";

import type { Msg } from "../types";

// Inline success / error banner used by every settings form.
export function Notice({ msg }: { msg: Msg }) {
  if (!msg) return null;
  const ok = msg.type === "success";
  return (
    <div
      className={`flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold ${
        ok
          ? "bg-[var(--pos)]/10 text-[var(--pos)]"
          : "bg-[var(--neg)]/10 text-[var(--neg)]"
      }`}
    >
      {ok ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
      {msg.text}
    </div>
  );
}
