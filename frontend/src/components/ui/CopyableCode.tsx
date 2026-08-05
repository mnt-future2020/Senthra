"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";

// A monospace code chip (e.g. an IRM item code "IRM-0002") that copies to the clipboard on click.
// Follows the app's existing copy pattern (navigator.clipboard + a transient "copied" tick).
//
// `label` shows something OTHER than the copied string — the goods queue makes the item NAME the
// copy target while copying the scan code behind it, so a manager clicks what they are reading
// rather than hunting for a separate chip. The copied value still appears in the tooltip and the
// aria-label, because a button that silently copies something you can't see is a button nobody
// trusts twice. Defaults to the code, so every existing caller is unchanged.
//
// Classes go through cn() rather than a template string: Tailwind resolves same-property
// classes by STYLESHEET order, not by their order in the attribute, so a caller passing
// `text-[11px]` would not reliably beat the default `text-[10px]` below. twMerge drops the
// loser, which is what makes `className` an actual override instead of a suggestion.
export function CopyableCode({
  code,
  label,
  className,
  onCopied,
}: {
  code: string;
  label?: string;
  className?: string;
  /**
   * Fired with the copied value after a SUCCESSFUL write. Exists so a caller can name the value
   * somewhere outside the row — a toast — because nothing in-row can do it without either pushing the
   * layout or covering a neighbour. Not called when the clipboard is unavailable, so a confirmation
   * can never claim a copy that didn't happen.
   */
  onCopied?: (code: string) => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation(); // don't trigger a parent row's click (e.g. opening a modal)
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      onCopied?.(code);
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
      title={copied ? `Copied ${code}` : `Copy ${code}`}
      // In LABELLED mode the visible text is the item NAME, and aria-label REPLACES it — so a bare
      // "Copy code IRS-0009" made the name unreadable to a screen reader in the one cell that carries
      // it. The name comes first, exactly as a sighted user reads the row, with the action after it.
      aria-label={label ? `${label} — copy code ${code}` : `Copy code ${code}`}
      className={cn(
        "group inline-flex items-center gap-1 transition-colors hover:text-[var(--accent)]",
        label === undefined && "font-mono text-[10px] text-[var(--muted)]",
        className,
      )}
    >
      {label ?? code}
      {/* The tick swaps into the copy icon's slot, which is already reserved (the icon is hidden with
          opacity, not removed), so confirming costs no width and nothing on the row moves.

          Naming the copied value is NOT done here. Inline it added ~90px to a table cell for 1.5s and
          shoved every column sideways; absolutely positioned it stopped moving anything but landed on
          top of whatever sat to the right — in the goods queue, straight over the "This warehouse"
          badge, leaving both unreadable. Any in-row treatment either pushes or covers. Callers that
          want the value named pass `onCopied` and route it to a toast, which is out of the layout
          entirely — see GoodsManagementTab. */}
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-[var(--pos)]" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}
