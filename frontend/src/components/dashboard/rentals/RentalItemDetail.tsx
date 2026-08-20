"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import * as rentalService from "@/services/rental.service";
import type { RentalItem } from "@/types/rental";
import type { UserStatus } from "@/types/user";
import { BarcodePanel } from "@/components/dashboard/irm/BarcodePanel";
import { RentalItemHires } from "./RentalItemHires";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDate } from "@/lib/formatDate";
import { printLabels } from "@/lib/printBarcode";

// Rentals live in the Inventory Hub, so that's where a deleted item returns you to.
const RENTAL_LIST = "/dashboard/inventory?tab=rental&rental=catalogue";

// Same card/field pair every other detail page in the dashboard renders its overview with (IRM item,
// supplier, warehouse) — a rental item is one more catalogue record and should not look like a
// different kind of page.
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <h2 className="mb-4 text-sm font-extrabold text-[var(--ink)]">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // min-w-0 + wrap-break-word so a long description breaks instead of spilling into the next
    // column — see the note in IrmItemDetail's copy.
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</p>
      <div className="mt-0.5 text-sm wrap-break-word text-[var(--ink)]">{children || "—"}</div>
    </div>
  );
}

/**
 * The label, fetched on mount.
 *
 * The panel is only mounted once the image is in hand: its empty state offers a "Generate barcode"
 * button, which is the one thing this surface must never show — there is nothing to generate, and a
 * button that mints nothing is a button that lies. A failed fetch says so and offers a retry rather
 * than sitting on a spinner, because the only honest reasons to be here are "not loaded yet" and
 * "the server could not render it".
 */
function BarcodeCard({ code, id }: { code: string; id: string }) {
  const [dataUri, setDataUri] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  // Bumped by Try again. The RETRY is a state change in an event handler and the fetch is a plain
  // promise chain in the effect — the shape AuditTrail uses, and the one the compiler-compat lint
  // allows: an async function called straight from an effect trips `set-state-in-effect`.
  const [attempt, setAttempt] = React.useState(0);
  const [copies, setCopies] = React.useState("");

  React.useEffect(() => {
    let active = true;
    rentalService
      .getRentalItemBarcode(id)
      .then((r) => active && setDataUri(r.barcodeDataUri))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [id, attempt]);

  const retry = () => {
    setFailed(false);
    setAttempt((n) => n + 1);
  };

  if (failed) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-[var(--muted)]">The label could not be rendered.</p>
        <button
          type="button"
          onClick={retry}
          className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-colors hover:bg-[var(--surface-2)]"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!dataUri) {
    return (
      <div className="flex items-center gap-3">
        <Skeleton className="h-24 w-44 rounded-xl" />
        <Skeleton className="h-4 w-48" />
      </div>
    );
  }

  return (
    <BarcodePanel
      code={code}
      barcodeDataUri={dataUri}
      // Nothing here creates or changes a record, so viewing the item is enough to print its label —
      // the same rule the panel already applies to reprinting an existing barcode elsewhere.
      canManage={false}
      busy={false}
      onPrint={(n) => printLabels({ dataUri, code, copies: n })}
      copies={copies}
      onCopiesChange={setCopies}
      // One sticker by default: a catalogue row is one kind of equipment, not a quantity of it. The
      // box is there for the three that smudged.
      defaultCopies={1}
    />
  );
}

/**
 * One rental item.
 *
 * Deliberately price-free: this master says WHAT can be hired. A hire's cost is agreed per request
 * and shown on the PRF line; its live state lives on the On hire tab.
 */
export function RentalItemDetail({ item }: { item: RentalItem }) {
  const router = useRouter();
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await rentalService.deleteRentalItem(item.id);
      pushToast("Rental item deleted.", "success");
      router.push(RENTAL_LIST);
    } catch (e) {
      // The server refuses while any purchase request or order still references it, and its
      // message names which — surface it rather than a generic failure.
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
      setConfirmOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="stack flex h-full flex-col">
      <DetailHeader
        storageKey="rental-detail"
        title={item.name}
        badges={<StatusBadge status={item.status as UserStatus} />}
        meta={
          <>
            <span className="font-mono">{item.code}</span>
            <span aria-hidden>·</span>
            <span>{item.rentalCategoryName ?? "—"}</span>
            <span aria-hidden>·</span>
            <span>{item.baseUnit}</span>
          </>
        }
        actions={
          <>
            {can("rentals.edit") && (
              <button
                type="button"
                onClick={() => router.push(`/dashboard/rentals/${item.code}/edit`)}
                className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90"
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
            )}
            {can("rentals.delete") && (
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                aria-label="Delete rental item"
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--neg)] transition-all hover:bg-[var(--neg)]/10"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid gap-4 lg:grid-cols-2">
          {/* WHERE THIS EQUIPMENT IS — first, and full width.
              First, because it is the only card here that changes day to day, and because a scanned
              label lands on this page: the person holding the kit is asking about the kit, not about
              who created the row.
              Full width, because it is a LIST — order, supplier, address, quantities and a deadline
              per row — and because a short card in a two-column grid pushes the next one into the
              row below it, leaving an empty cell beside it. That hole is not whitespace; it reads as
              something that failed to load. */}
          {can("rentals.view") && (
            <div className="lg:col-span-2">
              {/* No Card wrapper here: the component chooses its own weight — a bordered panel when
                  there are hires to list, a single line when there are none. */}
              <RentalItemHires rentalItemId={item.id} />
            </div>
          )}

          <Card title="Classification">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">{item.rentalCategoryName ?? "—"}</Field>
              <Field label="Unit">{item.baseUnit}</Field>
              <div className="col-span-2">
                <Field label="Description">{item.description}</Field>
              </div>
              <div className="col-span-2">
                <Field label="Notes">{item.notes}</Field>
              </div>
            </div>
          </Card>

          <Card title="Record">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Created">{formatDate(item.createdAt)}</Field>
              <Field label="Updated">{formatDate(item.updatedAt)}</Field>
              <Field label="Created by">{item.createdBy}</Field>
              <Field label="Updated by">{item.updatedBy}</Field>
            </div>
          </Card>

          {/* The sticker that goes on the kit when it arrives in the warehouse. The SAME panel the
              IRM item, both stock-entry surfaces and the two receive forms use, so a label printed
              from here comes off the printer identical to every other one.

              No Generate step: the label is Code128 of this item's permanent code, so it exists as
              soon as the item does — for the rows added today and the ones already in the database.
              See rental-item.service.ts. */}
          <div className="lg:col-span-2">
            <Card title="Barcode">
              <BarcodeCard code={item.code} id={item.id} />
            </Card>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Delete rental item"
        confirmLabel="Delete"
        danger
        busy={deleting}
        onClose={() => setConfirmOpen(false)}
        onConfirm={remove}
        message={
          <>
            Delete <strong className="text-[var(--ink)]">{item.name}</strong>? An item referenced by any purchase
            request or order cannot be deleted.
          </>
        }
      />
    </div>
  );
}
