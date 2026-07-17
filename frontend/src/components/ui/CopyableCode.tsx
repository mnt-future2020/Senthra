"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";

// A monospace code chip (e.g. an IRM item code "IRM-0002") that copies to the clipboard on click.
// Follows the app's existing copy pattern (navigator.clipboard + a transient "copied" tick).
export function CopyableCode({ code, className }: { code: string; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation(); // don't trigger a parent row's click (e.g. opening a modal)
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context) — silently ignore */
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? "Copied" : `Copy ${code}`}
      aria-label={`Copy code ${code}`}
      className={`group inline-flex items-center gap-1 font-mono text-[10px] text-[var(--muted)] transition-colors hover:text-[var(--accent)] ${className ?? ""}`}
    >
      {code}
      {copied ? (
        <Check className="h-3 w-3 text-[var(--pos)]" />
      ) : (
        <Copy className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}
