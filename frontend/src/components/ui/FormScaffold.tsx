"use client";

import * as React from "react";
import { ArrowLeft } from "lucide-react";

import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";

// Shared page chrome for the full-page Add/Edit forms (users + roles): a sticky
// header bar, a titled section card, a layout-matched skeleton, and an error state.
// Keeps the two forms visually consistent with the rest of the app (full-width,
// card-based) instead of a cramped centered modal.

export function FormPageHeader({
  title,
  subtitle,
  onBack,
  actions,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div className="sticky -top-4 z-20 -mx-4 -mt-4 flex items-center justify-between gap-4 border-b border-[var(--border)] bg-[var(--bg)] px-4 py-4 shadow-sm md:-top-8 md:-mx-8 md:-mt-8 md:px-8">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--muted)] transition-all hover:border-[var(--accent)] hover:text-[var(--ink)]"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-extrabold tracking-tight text-[var(--ink)]">
            {title}
          </h1>
          {subtitle && <p className="truncate text-xs text-[var(--muted)]">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function FormSection({
  title,
  description,
  invalid,
  action,
  children,
}: {
  title: React.ReactNode;
  description?: string;
  // When true, the section shows a red ring — flags a section-level requirement (e.g. a barcode that
  // must be generated before activating) the same way a field error is flagged.
  invalid?: boolean;
  // Section-level action(s) — rendered on the RIGHT of the title row. Sections used to put their
  // "Add …" button in a right-aligned row of its own below the heading, which left an empty band
  // across the width of the card. Pairing it with the title uses the space that was already there.
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`border bg-[var(--surface)] p-5 shadow-xs sm:p-6 ${invalid ? "border-[var(--neg)]" : "border-[var(--border)]"}`}
      style={{ borderRadius: "var(--radius)" }}
    >
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-extrabold text-[var(--ink)]">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-[var(--muted)]">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * Wrapper for one field in a multi-column form row.
 *
 * Forms across the dashboard hand-roll `<label className={labelCls}>` + control
 * rather than using `<Field>`. In a grid row of side-by-side fields, a label long
 * enough to wrap to two lines pushes only its own control down, leaving that input
 * sitting lower than its row-mates (e.g. "Supplier item code" in a 2/12 cell).
 *
 * This lays the pair out as a 3-row grid (label / control / anything trailing, such as
 * an error or hint), mirroring `<Field>`. The label and control rows size to content
 * and the trailing `1fr` row absorbs the cell's spare height, so a longer hint or error
 * under one field never shifts the control above it.
 *
 * Like `<Field>`, it does not equalise label heights across a row — a label that wraps
 * to two lines still sits its control ~16px lower than its row-mates. See the note in
 * Field.tsx for why, and why a `min-h` floor is the wrong cure.
 *
 * Use it as the grid child, carrying the col-span:
 *
 *   <FormField className="sm:col-span-3">
 *     <label className={labelCls}>Supplier item code</label>
 *     <input className={inputCls} … />
 *   </FormField>
 */
export function FormField({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`grid h-full grid-rows-[auto_auto_1fr] content-start ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

// A sticky aside card (the right column of a form): summary / photo / preview.
export function FormAsideCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs"
      style={{ borderRadius: "var(--radius)" }}
    >
      <p className="mb-4 text-[11px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
        {title}
      </p>
      {children}
    </section>
  );
}

/**
 * One `label —————— value` line of a form's summary aside.
 *
 * WHY THIS EXISTS
 * Every aside in the app hand-rolled `<div className="flex justify-between gap-3">` with two bare
 * spans, and none of them guarded the value. A flex item's default `min-width: auto` refuses to
 * shrink below its content, and an email or a warehouse code is a single unbreakable token — so
 * "shahul@mntfuture.com" under "Created by" rendered straight through the right edge of the card
 * and out over the page. It was invisible until a value happened to be long enough, which is why it
 * survived in six asides at once.
 *
 * The fix is two classes, and they only work as a pair: `shrink-0` on the LABEL (so the label is not
 * squeezed instead) and `min-w-0` + `wrap-break-word` on the VALUE (so it may shrink, and may break
 * mid-token when there is no space to break at).
 *
 * `valueClassName` goes through `cn()` — Tailwind resolves same-property classes by stylesheet
 * order, not attribute order, so a caller passing `text-[var(--neg)]` needs twMerge to actually beat
 * the default. Money and quantity rows pass their own weight/colour and are unaffected by the
 * wrapping rules, which never fire on a short value.
 */
export function SummaryRow({
  label,
  valueClassName,
  className,
  children,
}: {
  label: React.ReactNode;
  /** Weight / colour for the value — e.g. "font-extrabold text-[var(--neg)]". */
  valueClassName?: string;
  /** Extra classes for the ROW, e.g. a separator: "border-t border-[var(--border)] pt-2.5". */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    // `flex-wrap` is the half that makes this READ well, not just fit. The aside is ~200px wide on a
    // 1024px laptop, so an email beside its label has ~90px and breaks into three ragged fragments.
    // Wrapping drops the value onto its own full-width line first — where it usually fits whole — and
    // the character-level break below stays as the last resort for a value too long even for that.
    <div className={cn("flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5", className)}>
      <span className="shrink-0 text-[var(--muted)]">{label}</span>
      <span className={cn("min-w-0 grow text-right wrap-break-word text-[var(--ink)]", valueClassName)}>{children}</span>
    </div>
  );
}

function CardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div
      className="border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xs"
      style={{ borderRadius: "var(--radius)" }}
    >
      <Skeleton className="mb-5 h-4 w-32" />
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: rows * 2 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-10 w-full rounded-xl" />
          </div>
        ))}
      </div>
    </div>
  );
}

// Loading placeholder that mirrors the form's two-column layout, so the page
// doesn't jump when the real form mounts.
export function FormPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="-mx-4 flex items-center justify-between border-b border-[var(--border)] px-4 py-3 md:-mx-8 md:px-8">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-20 rounded-xl" />
          <Skeleton className="h-9 w-28 rounded-xl" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <CardSkeleton rows={3} />
          <CardSkeleton rows={2} />
        </div>
        <div className="space-y-6">
          <div
            className="border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs"
            style={{ borderRadius: "var(--radius)" }}
          >
            <Skeleton className="mb-4 h-3 w-24" />
            <Skeleton className="mx-auto h-20 w-20 rounded-full" />
            <Skeleton className="mx-auto mt-4 h-3 w-28" />
            <Skeleton className="mx-auto mt-2 h-2.5 w-36" />
          </div>
        </div>
      </div>
    </div>
  );
}

// Shown by a form page when the record it needs can't be loaded.
export function FormError({ message }: { message: string }) {
  return (
    <div className="mx-auto w-full max-w-2xl py-12 text-center text-sm font-semibold text-[var(--neg)]">
      {message}
    </div>
  );
}

/**
 * The validation message for ONE field, rendered directly beneath it.
 *
 * Pair it with `aria-invalid` on the input and `aria-describedby={id}` — `inputCls` already carries
 * the `aria-[invalid=true]` red border/ring, so the two together give the field a visible and an
 * announced error without any extra styling at the call site.
 *
 * Use this rather than a toast for validation. A toast dismisses itself, leaving the user to hunt for
 * the field it was about, and it isn't associated with the input for a screen reader. Toasts are for
 * outcomes (saved, failed to save); field problems belong next to the field.
 *
 * `data-invalid` makes the message itself a target for `focusFirstInvalid`. It matters for the errors
 * that belong to a SECTION rather than a control — "add at least one item" under a line table, where
 * there is no input to carry `aria-invalid`. Without it those submits set an error, raised a toast
 * and scrolled nothing, which reads as the Save button being broken. For an ordinary field the input
 * sits EARLIER in document order, so it still wins and still takes focus; this only fills the gap.
 *
 * Every form in the dashboard had its own byte-identical copy of this (sixteen of them). They now all
 * import this one — which is the point: a fix like the `data-invalid` above lands everywhere at once
 * instead of in whichever copies someone remembered.
 */
export function FieldError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} data-invalid="true" className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">
      {message}
    </p>
  );
}

// A small red asterisk marking a required field. Decorative (aria-hidden) — the
// matching input carries aria-required so assistive tech announces it.
export function RequiredMark() {
  return (
    <span aria-hidden="true" className="ml-0.5 text-[var(--neg)]">
      *
    </span>
  );
}
