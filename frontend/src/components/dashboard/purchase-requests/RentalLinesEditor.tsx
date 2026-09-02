"use client";

import * as React from "react";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";

import { RentalItemPicker } from "@/components/dashboard/rentals/RentalItemPicker";
import { inputCls } from "@/components/ui/styles";
import { NumberInput } from "@/components/ui/NumberInput";
import { Select } from "@/components/ui/Select";
import { FieldError, FormSection } from "@/components/ui/FormScaffold";
import { formatMoney } from "./prfStatus";
import type { RentalItem } from "@/types/rental";
import {
  agreedUnitPrice,
  applyBasisChange,
  billablePeriods,
  blankRentalLine,
  calculatedUnitPrice,
  capNotifyLead,
  duplicateRentalRowKeys,
  DUPLICATE_ROW_MESSAGE,
  hireDateNotice,
  hireRangeError,
  notifyLeadMax,
  RATE_PERIOD_OPTIONS,
  reminderDate,
  rentalDeliveryFallback,
  returnModeOptions,
  rowHireDays,
  type RatePeriod,
  type RentalLineRow,
  type ReturnMode,
} from "./rentalLineRows";

const cellLabel = "mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]";

/**
 * The per-row destination picker — the multi-warehouse ORDER create only, where every line names
 * the depot it is delivered to and the order auto-splits by it. A request (and an order being
 * edited) has one warehouse on its header and passes nothing here.
 */
export interface RowWarehousePicker {
  options: { value: string; label: string }[];
  /** The row's destination — the locked depot for a single-warehouse manager, else the row's own. */
  valueFor: (row: RentalLineRow) => string;
  /** A manager assigned exactly one warehouse has it chosen for them and cannot change it. */
  locked: boolean;
  loading: boolean;
}

/**
 * The rental-lines grid — ONE editor for every document that carries a hire.
 *
 * Extracted from the purchase request form so the purchase order form could show the same rows
 * rather than a second copy of them: a hire is the same line on both documents, validated by one
 * server schema, and two grids would drift the first time one gained a field. Every rule the grid
 * applies lives in `rentalLineRows.ts`, where it is tested; this file is only the layout.
 *
 * The caller owns the rows and the catalogue. The grid never reads the catalogue itself — the
 * picker searches the server, and whatever it finds is handed back through `onCatalogue` so the
 * caller's state stays the one source of item names.
 */
export function RentalLinesEditor({
  rows,
  setRows,
  catalogue,
  onCatalogue,
  canCreate,
  loading,
  today,
  warehouseNameFor,
  rowWarehouse,
  orderDeliveryAddress,
  onTouch,
  error,
  title = "Rental lines",
  description,
}: {
  rows: RentalLineRow[];
  setRows: React.Dispatch<React.SetStateAction<RentalLineRow[]>>;
  /** The catalogue rows on hand — the picker's seed, and where a row's label comes from. */
  catalogue: RentalItem[];
  /** Merge freshly picked (searched, created or resolved) items into the caller's catalogue. */
  onCatalogue: (items: RentalItem[]) => void;
  /** `rentals.create` — without it no create affordance is rendered at all. */
  canCreate: boolean;
  /** Reference data (or the saved lines' items) still loading, so a set row must not read as empty. */
  loading: boolean;
  /** "Today" for the past-date notice — null on the server render, see the form's useSyncExternalStore. */
  today: string | null;
  /** The depot a row's "Collect from warehouse" names — the header warehouse, or the row's own. */
  warehouseNameFor: (row: RentalLineRow) => string | null;
  rowWarehouse?: RowWarehousePicker;
  /**
   * The ORDER's "deliver to a different address" override, when the document has one and it is set.
   * A line with no address of its own is delivered there rather than to the warehouse, and the row
   * has to say so — a placeholder promising the warehouse while the order says otherwise is the one
   * wording on this form that would be plainly false. A request has no override and passes nothing.
   */
  orderDeliveryAddress?: string | null;
  onTouch: () => void;
  error?: string;
  title?: string;
  description: string;
}) {
  // Which hire rows repeat one above them. Resolved for the whole section at once because a row
  // cannot see its neighbours: computed per row it would be the same scan of the same list N times,
  // and the answer has to agree with the submit-time check to the letter.
  const duplicateKeys = React.useMemo(() => duplicateRentalRowKeys(rows), [rows]);
  // What a blank line address resolves to — see rentalDeliveryFallback. Named in the placeholder
  // and in the return-mode hint, which both used to assume the warehouse.
  const fallback = rentalDeliveryFallback(orderDeliveryAddress);

  return (
    <FormSection title={title} description={description}>
      <div className="space-y-3">
        {rows.map((row, idx) => {
          const picked = catalogue.find((r) => r.id === row.rentalItemId);
          const days = rowHireDays(row);
          const duplicate = duplicateKeys.has(row._key);
          // ONE message per row, and the blocking one wins: while the range itself is
          // impossible, "this hire has already ended" is a true statement about the wrong
          // problem.
          const rangeError = hireRangeError(row);
          const reminderOn = reminderDate(row);
          const calculated = calculatedUnitPrice(row);
          const periods = billablePeriods(row);
          // What the line will actually be saved with — the calculation, or the typed figure
          // once someone has overridden it. The server applies the identical rule.
          const agreed = agreedUnitPrice(row);
          const setRow = (patchRow: Partial<RentalLineRow>) => {
            setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patchRow } : r)));
            onTouch();
          };
          // Switching basis is a COMMERCIAL change, not a formatting one: £55/day and £55/week
          // are different money. The rate is kept (retyping it is worse) and the recalculated
          // figure is shown, so the review is unavoidable rather than implied. The rule itself
          // lives in rentalLineRows so it can be tested — including the part that stops a
          // switch to "total" blanking a price the box was displaying a moment earlier.
          const changeBasis = (next: RatePeriod) => setRow(applyBasisChange(row, next));
          const notice = rangeError || duplicate || !today ? undefined : hireDateNotice(row, today);
          const warehouseName = warehouseNameFor(row);
          return (
            <div key={row._key} className="@container rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-3">
              <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @xl:grid-cols-4 @3xl:grid-cols-12">
                <div className="min-w-0 @sm:col-span-2 @xl:col-span-4 @3xl:col-span-4">
                  <label className={cellLabel}>Rental item</label>
                  <RentalItemPicker
                    value={row.rentalItemId}
                    selectedItem={picked ?? null}
                    seed={catalogue}
                    // No price is prefilled: the catalogue holds none. What a hire costs is
                    // agreed for THIS document, so it is typed in below alongside the period.
                    // Only the id changes here — quantity, dates, basis, rate and VAT on this
                    // row are deliberately left exactly as the user set them.
                    onSelect={(item) => {
                      onCatalogue([item]);
                      setRow({ rentalItemId: item.id });
                    }}
                    canCreate={canCreate}
                    loading={loading}
                    // The item is the field most likely to be the mistake — the same kit picked
                    // twice — and marking it points at the row to delete rather than at the row
                    // it collides with.
                    invalid={duplicate}
                  />
                </div>
                <div className="min-w-0 @xl:col-span-2 @3xl:col-span-2">
                  <label className={cellLabel}>Qty</label>
                  <NumberInput className={inputCls} min="1" step="1" value={row.quantity} onChange={(e) => setRow({ quantity: e.target.value })} />
                </div>
                <div className="min-w-0 @xl:col-span-2 @3xl:col-span-3">
                  <label className={cellLabel}>Hire start</label>
                  <input type="date" className={inputCls} value={row.hireStartDate} onChange={(e) => setRow({ hireStartDate: e.target.value })} />
                </div>
                <div className="min-w-0 @xl:col-span-2 @3xl:col-span-3">
                  <label className={cellLabel}>Hire end</label>
                  {/* `min` so the native calendar cannot even scroll to a day the form would
                      reject — the treatment UserForm's date bounds and the PO's confirmed
                      delivery date already get. It is the FIRST of three layers, not the only
                      one: a typed date walks straight past `min`, so the row still says so
                      below, and validate() still refuses the submit. */}
                  <input
                    type="date"
                    className={inputCls}
                    value={row.hireEndDate}
                    min={row.hireStartDate || undefined}
                    aria-invalid={Boolean(rangeError)}
                    onChange={(e) => setRow({ hireEndDate: e.target.value })}
                  />
                </div>
                <div className="min-w-0 @xl:col-span-2 @3xl:col-span-3">
                  <label className={cellLabel}>Pricing basis</label>
                  <Select
                    value={row.ratePeriod}
                    onChange={(v) => changeBasis(v as RatePeriod)}
                    options={RATE_PERIOD_OPTIONS}
                    ariaLabel="Pricing basis"
                  />
                </div>
                {row.ratePeriod !== "total" && (
                  <div className="min-w-0 @xl:col-span-2 @3xl:col-span-2">
                    <label className={cellLabel}>Rate (£)</label>
                    <NumberInput
                      className={inputCls}
                      min="0"
                      step="0.01"
                      value={row.rate}
                      title={`The quoted rate per ${row.ratePeriod}.`}
                      onChange={(e) => setRow({ rate: e.target.value })}
                    />
                  </div>
                )}
                <div className={`min-w-0 @xl:col-span-2 ${row.ratePeriod === "total" ? "@3xl:col-span-4" : "@3xl:col-span-3"}`}>
                  {/* ONE label on every basis. It is the same field and the same stored
                      column whichever basis is picked; naming it "Price per unit" on `total`
                      and "Agreed / unit" on a rate suggested two different things, and the
                      one thing a reader must never have to hunt for is which number is the
                      money. */}
                  <label className={cellLabel}>Agreed price / unit</label>
                  {/* The stored value is `unitPricePence` and the line total is quantity ×
                      this — never × days. On a rate basis it is filled by the calculation;
                      typing over it marks the line overridden, and nothing recalculates it
                      afterwards. */}
                  <NumberInput
                    className={inputCls}
                    min="0"
                    step="0.01"
                    value={row.ratePeriod !== "total" && !row.priceOverridden ? (calculated ?? 0).toFixed(2) : row.unitPrice}
                    title="The agreed price for ONE unit for the whole hire period — not a daily rate."
                    onChange={(e) =>
                      setRow(
                        row.ratePeriod === "total"
                          ? { unitPrice: e.target.value }
                          : { unitPrice: e.target.value, priceOverridden: true },
                      )
                    }
                  />
                </div>
                <div className="min-w-0 @xl:col-span-2 @3xl:col-span-2">
                  <label className={cellLabel}>VAT %</label>
                  <NumberInput className={inputCls} min="0" max="100" step="0.1" value={row.vatRate} onChange={(e) => setRow({ vatRate: e.target.value })} />
                </div>
                <div className="min-w-0 @xl:col-span-2 @3xl:col-span-2">
                  <label className={cellLabel}>Reminder (days)</label>
                  {/* The ceiling follows the HIRE, like Hire end's `min` follows the start date:
                      a 3-day notice on a 2-day hire is a lead the server can only clamp to the
                      first day, so the box that offered it would sit beside a reminder date
                      three days off and look broken. Capping it means the contradiction cannot
                      appear, and the row needs no sentence explaining one away.

                      `max` is advisory on its own — typing walks past it, and a lead typed
                      against a longer hire outlives the shortening of that hire — so the value
                      is capped on the way out too. Read time, not written back: the typed lead
                      survives in state and returns if the hire is stretched out again. */}
                  <NumberInput
                    className={inputCls}
                    min="0"
                    max={String(notifyLeadMax(days))}
                    step="1"
                    value={capNotifyLead(row.notifyDaysBefore, days)}
                    title="How many days before the hire end date the reminder is sent."
                    onChange={(e) => setRow({ notifyDaysBefore: e.target.value })}
                  />
                </div>
                {/* WHERE IT IS DELIVERED — the order create only. Each line names its depot, the
                    order splits by it, and the hire's custody is anchored there once it arrives.
                    Leads the logistics row so the two addresses that follow read against it. */}
                {rowWarehouse && (
                  <div className="min-w-0 @sm:col-span-2 @xl:col-span-4 @3xl:col-span-4">
                    <label className={cellLabel}>Warehouse</label>
                    <Select
                      value={rowWarehouse.valueFor(row)}
                      onChange={(v) => setRow({ warehouseId: v })}
                      options={rowWarehouse.options}
                      placeholder={rowWarehouse.loading && !rowWarehouse.valueFor(row) ? "Loading…" : "— Select —"}
                      ariaLabel="Destination warehouse"
                      disabled={rowWarehouse.locked || (rowWarehouse.loading && !rowWarehouse.valueFor(row))}
                    />
                  </div>
                )}
                <div className="min-w-0 @sm:col-span-2 @xl:col-span-4 @3xl:col-span-4">
                  <label className={cellLabel}>Delivery address (optional)</label>
                  <textarea
                    className={inputCls}
                    rows={1}
                    maxLength={300}
                    placeholder={`Leave blank for ${fallback}`}
                    value={row.deliveryAddress}
                    onChange={(e) => setRow({ deliveryAddress: e.target.value })}
                  />
                </div>

                {/* WHERE IT GOES BACK. A hire is a round trip, and this leg used to be stated
                    nowhere: the order told the supplier where to deliver and said nothing
                    about collection, so it got settled by phone.

                    A mode rather than an optional address box, because an optional box is
                    blank on nearly every line and a blank answers nothing. Every mode
                    resolves to a real place, so the order prints a definite collection point
                    on every line.

                    The two top modes land on the SAME place while the address above is blank,
                    and differ later — one follows the delivery address, the other is fixed on
                    the depot — so the difference is stated on hover, the treatment Rate,
                    Agreed price and Reminder already get. Not a helper line under the select:
                    this section is the tallest thing on a 1024px screen, and a line per row
                    would say it once per hire. */}
                <div
                  className="min-w-0 @sm:col-span-2 @xl:col-span-4 @3xl:col-span-4"
                  title={`Same as delivery — the supplier collects from wherever this line is delivered, which is ${fallback} while the address above is blank. Collect from warehouse — always the selected warehouse, even when the line is delivered somewhere else. Other address — a collection point you type in.`}
                >
                  <label className={cellLabel}>Return at end of hire</label>
                  <Select
                    value={row.returnMode}
                    onChange={(v) => setRow({ returnMode: v as ReturnMode })}
                    options={returnModeOptions(warehouseName)}
                    ariaLabel="Return at end of hire"
                  />
                </div>
                {row.returnMode === "other" && (
                  <div className="min-w-0 @sm:col-span-2 @xl:col-span-4 @3xl:col-span-4">
                    <label className={cellLabel}>Collection address</label>
                    <textarea
                      className={inputCls}
                      rows={1}
                      maxLength={300}
                      placeholder="Where the supplier collects this hire from."
                      value={row.returnAddress}
                      onChange={(e) => setRow({ returnAddress: e.target.value })}
                    />
                  </div>
                )}

                {/* The line's own notes. Shares the logistics row rather than opening another —
                    the section is already the tallest thing on a 1024px screen — and takes
                    whatever width that row has left, so the twelve columns always add up. */}
                <div
                  className={`min-w-0 @sm:col-span-2 @xl:col-span-4 ${
                    rowWarehouse
                      ? row.returnMode === "other"
                        ? "@3xl:col-span-8"
                        : "@3xl:col-span-12"
                      : row.returnMode === "other"
                        ? "@3xl:col-span-12"
                        : "@3xl:col-span-4"
                  }`}
                >
                  <label className={cellLabel}>Notes (optional)</label>
                  <textarea
                    className={inputCls}
                    rows={1}
                    maxLength={2000}
                    placeholder="Anything the approver or supplier should know about this hire."
                    value={row.notes}
                    onChange={(e) => setRow({ notes: e.target.value })}
                  />
                </div>
              </div>
              {/* Footer strip — the hire summary on the left, Remove on the right, matching the
                  IRM line's "Line total / remove" strip above. The button used to be a grid cell,
                  which claimed an entire row to itself once the grid collapsed to one column. */}
              <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-[var(--border)] pt-2.5">
                {days !== null && days > 0 ? (
                  <p className="min-w-0 text-[11px] text-[var(--muted)]">
                    <strong className="text-[var(--ink)]">
                      {days} day{days === 1 ? "" : "s"}
                    </strong>{" "}
                    hire
                    {row.ratePeriod === "total"
                      ? ` · the price is for the whole period${picked?.baseUnit ? `, per ${picked.baseUnit.toLowerCase()}` : ""}.`
                      : periods != null
                        ? ` · ${periods} ${row.ratePeriod}${periods === 1 ? "" : "s"} charged${
                            row.ratePeriod === "week"
                              ? " (part weeks are charged as full weeks)"
                              : row.ratePeriod === "month"
                                ? " (part months are charged as full months)"
                                : " (the return date is not charged)"
                          }.`
                        : "."}
                    {reminderOn ? ` Reminder on ${reminderOn.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })}.` : ""}
                  </p>
                ) : (
                  // Keeps the strip's justify-between honest so the button stays hard right
                  // before any dates are entered.
                  <span />
                )}
                <button
                  type="button"
                  onClick={() => {
                    setRows((rs) => rs.filter((_, i) => i !== idx));
                    onTouch();
                  }}
                  className="shrink-0 rounded-lg p-2 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--neg)]"
                  title="Remove rental line"
                  aria-label="Remove rental line"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {/* A WARNING, not a rule: back-dating is legitimate (the kit went out last week
                  and the paperwork is catching up), so the line still saves. It is said out
                  loud because the alternative is a purchase order that is overdue the moment
                  it exists — straight onto the red badge, with its reminder already due. */}
              {rangeError && (
                <p className="mt-1 flex items-start gap-1.5 text-[11px] font-semibold text-[var(--neg)]" data-invalid="true">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                  {rangeError}
                </p>
              )}
              {/* The duplicate rule, said on the row that breaks it. The submit banner sits
                  under the whole section, so with four hire lines on screen it announces that
                  something is duplicated and leaves the reader to find which two — the exact
                  problem the range error above was moved onto the row to solve.

                  Only ever on the SECOND and later of a set: the first is the line to keep, and
                  marking both makes the row to delete ambiguous. One sentence, matching its
                  siblings above — the full rule, including what it ignores, is in the submit
                  banner where there is room for it. */}
              {duplicate && !rangeError && (
                <p className="mt-1 flex items-start gap-1.5 text-[11px] font-semibold text-[var(--neg)]" data-invalid="true">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                  {DUPLICATE_ROW_MESSAGE}
                </p>
              )}
              {row.ratePeriod !== "total" && row.priceOverridden && calculated != null && (
                <p className="mt-1 flex items-start gap-1.5 text-[11px] font-semibold text-[var(--warn,#d97706)]">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                  Manually adjusted — the rate calculates {formatMoney(calculated)} per unit, this line is
                  agreed at {formatMoney(agreed)}.{" "}
                  <button
                    type="button"
                    onClick={() => setRow({ priceOverridden: false, unitPrice: calculated.toFixed(2) })}
                    className="font-bold underline underline-offset-2"
                  >
                    Use the calculated price
                  </button>
                </p>
              )}
              {notice && (
                <p className="mt-1 flex items-start gap-1.5 text-[11px] font-semibold text-[var(--warn,#d97706)]">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                  {notice}
                </p>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => {
            setRows((rs) => [...rs, blankRentalLine()]);
            onTouch();
          }}
          className="flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--accent)] transition-colors hover:bg-[var(--surface-2)]"
        >
          <Plus className="h-3.5 w-3.5" /> Add rental line
        </button>
        <FieldError id="err-rentalItems" message={error} />
      </div>
    </FormSection>
  );
}
