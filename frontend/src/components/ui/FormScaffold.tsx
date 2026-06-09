"use client";

import * as React from "react";
import { ArrowLeft } from "lucide-react";

import { Skeleton } from "@/components/ui/Skeleton";

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
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs sm:p-6"
      style={{ borderRadius: "var(--radius)" }}
    >
      <div className="mb-5">
        <h2 className="text-sm font-extrabold text-[var(--ink)]">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-[var(--muted)]">{description}</p>}
      </div>
      {children}
    </section>
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

// A small red asterisk marking a required field. Decorative (aria-hidden) — the
// matching input carries aria-required so assistive tech announces it.
export function RequiredMark() {
  return (
    <span aria-hidden="true" className="ml-0.5 text-[var(--neg)]">
      *
    </span>
  );
}
