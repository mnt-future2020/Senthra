"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { useReferenceData } from "@/hooks/useReferenceData";
import { useNavigationGuard, useReportDirty } from "@/providers/NavigationGuardProvider";
import * as rentalService from "@/services/rental.service";
import type { RentalCategory, RentalItem } from "@/types/rental";
import type { UserStatus } from "@/types/user";
import { CreatableSelect } from "@/components/ui/CreatableSelect";
import { Select } from "@/components/ui/Select";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FieldError, FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { ghostBtn, hintCls, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { focusFirstInvalid } from "@/lib/focusFirstInvalid";
import { UOM_SELECT_OPTIONS } from "@/lib/uom";
import { firstActiveId } from "@/lib/utils";

// The rental catalogue lives in the Inventory Hub (Inventory → Rentals → Catalogue), so that's the
// fallback destination when there's no in-app history to go back to. Mirrors IRM_LIST.
const RENTAL_LIST = "/dashboard/inventory?tab=rental&rental=catalogue";

/**
 * Create / edit a rental item.
 *
 * This master defines WHAT can be hired — name, category, unit — and deliberately nothing about
 * money. What a hire COSTS is negotiated per period and per supplier, so the price, VAT and
 * currency are captured on the purchase request's rental line, next to the dates they apply to.
 * A reference rate here would be a second, staler answer that drifts the moment a supplier quotes
 * anything else.
 *
 * Far shorter than the IRM item form for the same kind of reason: a hire has no stock policy, no
 * tracking flags and no barcode, so those fields would be captured and then read by nothing. The
 * page CHROME is identical to it all the same — sticky header with Back/Cancel/Save, titled
 * sections, summary aside — because a shorter form is not a different kind of page.
 */
export function RentalItemForm({ item }: { item?: RentalItem }) {
  const router = useRouter();
  const guard = useNavigationGuard();
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const editing = Boolean(item);
  const o = item;

  const [name, setName] = React.useState(o?.name ?? "");
  const [description, setDescription] = React.useState(o?.description ?? "");
  const [categoryId, setCategoryId] = React.useState(o?.rentalCategoryId ?? "");
  const [status, setStatus] = React.useState<"active" | "inactive">(o?.status ?? "active");
  const [baseUnit, setBaseUnit] = React.useState(o?.baseUnit ?? "Each");
  const [notes, setNotes] = React.useState(o?.notes ?? "");

  const [categories, setCategories] = React.useState<RentalCategory[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const { isLoading: refLoading } = useReferenceData(
    [
      {
        label: "rental categories",
        load: () => rentalService.listRentalCategories(),
        onData: (rows: RentalCategory[]) => {
          setCategories(rows);
          // Prefill the first ACTIVE category on create so the commonest path is one click shorter.
          if (!editing) setCategoryId((current) => current || firstActiveId(rows));
        },
      },
    ],
    [editing],
  );

  // Every active category, plus this item's own if it has since been deactivated — editing the name
  // must never silently re-point the item at a different category.
  const categoryOptions = React.useMemo(() => {
    const active = categories.filter((c) => c.status === "active");
    const current = categories.find((c) => c.id === categoryId);
    if (current && current.status !== "active") {
      return [{ ...current, name: `${current.name} (inactive)` }, ...active];
    }
    return active;
  }, [categories, categoryId]);

  // Dirty detection — the live field snapshot against the one the form opened with, so leaving with
  // unsaved edits is challenged (NavigationGuardProvider) rather than silently discarding them.
  const liveKey = JSON.stringify({ name, description, categoryId, status, baseUnit, notes });
  const initialKey = React.useMemo(
    () =>
      JSON.stringify({
        name: o?.name ?? "",
        description: o?.description ?? "",
        // On create the category is auto-preselected to the first active one — the baseline must
        // mirror that default, or the preselect alone reads as an edit.
        categoryId: editing ? (o?.rentalCategoryId ?? "") : firstActiveId(categories),
        status: o?.status ?? "active",
        baseUnit: o?.baseUnit ?? "Each",
        notes: o?.notes ?? "",
      }),
    [o, editing, categories],
  );
  useReportDirty("rental-item-form", !saved && liveKey !== initialKey);

  const goBack = () =>
    guard.attemptLeave(() => {
      if (window.history.length > 1) router.back();
      else router.push(RENTAL_LIST);
    });

  const clearError = (field: string) =>
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });

  const addCategory = async (label: string) => {
    const created = await rentalService.createRentalCategory({ name: label });
    setCategories((prev) => [...prev, created]);
    return { id: created.id, name: created.name };
  };

  const validate = () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Item name is required.";
    if (!categoryId) next.categoryId = "Select a rental category.";
    // A hire is always quantified in something, so the unit is required rather than optional.
    if (!baseUnit) next.baseUnit = "Select a unit.";
    return next;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setError(null);
    const fieldErrors = validate();
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      pushToast("Please fix the highlighted fields.", "alert");
      focusFirstInvalid();
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        rentalCategoryId: categoryId,
        status,
        baseUnit,
        notes: notes.trim(),
      };
      const savedItem = editing
        ? await rentalService.updateRentalItem(o!.id, payload)
        : await rentalService.createRentalItem(payload);
      // Before navigating: the guard must not challenge a departure the save itself caused.
      setSaved(true);
      pushToast(editing ? "Rental item updated." : `Rental item ${savedItem.code} created.`, "success");
      router.replace(`/dashboard/rentals/${savedItem.code}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save the rental item.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false);
    }
  };

  const canSubmit = editing ? can("rentals.edit") : can("rentals.create");

  return (
    <form onSubmit={submit} className="space-y-6">
      <FormPageHeader
        title={editing ? `Edit ${o?.name ?? "rental item"}` : "Add rental item"}
        subtitle={editing && o ? o.code : "A new item the company can hire"}
        onBack={goBack}
        actions={
          <>
            <button type="button" onClick={goBack} disabled={saving} className={ghostBtn}>
              Cancel
            </button>
            <button type="submit" disabled={saving || !canSubmit} className={primaryBtn}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {editing ? "Save changes" : "Create rental item"}
            </button>
          </>
        }
      />

      {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="Basic information" description="What the item is, and how a hire of it is counted.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>
                  Item name<RequiredMark />
                </label>
                <input
                  className={inputCls}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    clearError("name");
                  }}
                  placeholder="e.g. Fibre Tester (OTDR)"
                  maxLength={200}
                  autoFocus
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? "err-name" : undefined}
                />
                <FieldError id="err-name" message={errors.name} />
                <p className={hintCls}>A clear name staff will recognise when raising a request.</p>
              </div>

              <div>
                <label className={labelCls}>
                  Category<RequiredMark />
                </label>
                <CreatableSelect
                  value={categoryId}
                  onChange={(id) => {
                    setCategoryId(id);
                    clearError("categoryId");
                  }}
                  options={categoryOptions.map((c) => ({ id: c.id, name: c.name }))}
                  disabled={refLoading && !categoryId}
                  placeholder={refLoading && !categoryId ? "Loading categories…" : "— Select a category —"}
                  // Inline create, so adding a category mid-form is not a Settings round trip. Same
                  // admission the master-data convention gives every other domain master.
                  onCreate={addCategory}
                  canCreate={can("rental_categories.create") || can("rentals.create") || can("rentals.edit")}
                  canManage={can("rental_categories.edit") || can("rental_categories.delete")}
                  manageHref="/dashboard/inventory?tab=rental&rental=categories"
                  noun="category"
                  required
                  invalid={Boolean(errors.categoryId)}
                  describedBy={errors.categoryId ? "err-categoryId" : undefined}
                />
                <FieldError id="err-categoryId" message={errors.categoryId} />
                <p className={hintCls}>The kind of equipment this is.</p>
              </div>

              <div>
                <label className={labelCls}>
                  Unit<RequiredMark />
                </label>
                {/* The SAME closed list IRM items and customer stock entries offer (lib/uom.ts), and
                    the server validates against it. A free-text box here let "Each", "each" and "EA"
                    become three different units — on a value that is snapshotted onto the PRF line,
                    the PO line and the PDF the supplier reads. */}
                <Select
                  value={baseUnit}
                  onChange={(v) => {
                    setBaseUnit(v);
                    clearError("baseUnit");
                  }}
                  options={UOM_SELECT_OPTIONS}
                  ariaLabel="Unit"
                  invalid={Boolean(errors.baseUnit)}
                />
                <FieldError id="err-baseUnit" message={errors.baseUnit} />
                <p className={hintCls}>What a hire of this item is counted in.</p>
              </div>

              <div>
                <label className={labelCls}>Status</label>
                <Select
                  value={status}
                  onChange={(v) => setStatus(v as "active" | "inactive")}
                  options={[
                    { value: "active", label: "Active" },
                    { value: "inactive", label: "Inactive" },
                  ]}
                  ariaLabel="Status"
                />
                <p className={hintCls}>Inactive items stay on past requests but can&apos;t be added to new ones.</p>
              </div>

              <div className="sm:col-span-2">
                <label className={labelCls}>Description</label>
                <textarea
                  className={inputCls}
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={2000}
                  placeholder="Specification or usage notes (optional)."
                />
              </div>
            </div>
          </FormSection>

          <FormSection title="Notes" description="Internal context for whoever hires or handles this item.">
            <textarea
              className={inputCls}
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              placeholder="Internal notes — handling, calibration or supplier context."
            />
          </FormSection>
        </div>

        <div className="space-y-6">
          <FormAsideCard title="Summary">
            <div className="space-y-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Code</p>
                {/* No prefix quoted here. It is configurable in Settings → Branding, and this form cannot
                    read it — the full settings payload needs `settings.view`, which a person adding a
                    catalogue item may well not have, and the PUBLIC branding endpoint (served to the
                    login page with no auth) is no place for internal numbering conventions. A
                    hardcoded guess is worse than silence: it read "RNT-####" while the configured
                    prefix was something else entirely. */}
                <p className="mt-0.5 text-sm font-mono text-[var(--ink)]">
                  {editing && o ? o.code : "Auto-assigned on save"}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Status</p>
                <div className="mt-1">
                  <StatusBadge status={status as UserStatus} />
                </div>
              </div>
              <p className="border-t border-[var(--border)] pt-4 text-[11px] leading-relaxed text-[var(--muted)]">
                No rate is held here. What a hire costs is agreed per period and per supplier, so the price and VAT
                are entered on the purchase request&apos;s rental line — next to the hire dates they apply to.
              </p>
            </div>
          </FormAsideCard>
        </div>
      </div>
    </form>
  );
}
