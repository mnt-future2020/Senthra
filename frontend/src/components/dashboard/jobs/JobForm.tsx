"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";

import * as jobService from "@/services/job.service";
import { listCustomers, getCustomer, listCustomerStockEntries } from "@/services/customer.service";
import { listManagerOptions, listWarehouseOptions, type WarehouseOption } from "@/services/warehouse.service";
import { listIrmItems } from "@/services/irm.service";
import { getAvailability } from "@/services/inventory.service";
import { listSuppliers } from "@/services/supplier.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import { inputCls, labelCls } from "@/components/ui/styles";
import { FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { NumberInput } from "@/components/ui/NumberInput";
import { Select } from "@/components/ui/Select";
import { PostcodeField } from "@/components/ui/PostcodeField";
import {
  INSTALLER_TYPES,
  INSTALLER_TYPE_LABELS,
  JOB_LINE_TYPES,
  JOB_LINE_TYPE_LABELS,
  JOB_PRIORITIES,
  JOB_PRIORITY_LABELS,
  JOB_TYPES,
  JOB_TYPE_LABELS,
} from "./jobStatus";
import type { CustomerProject, CustomerSite, CustomerStockEntry } from "@/types/customer";
import type { Job, JobLineType } from "@/types/job";

const JOBS_LIST = "/dashboard/jobs";
const dateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");
const num = (s: string) => Number(s) || 0;

type Opt = { value: string; label: string };
type KitLine = {
  _key: string;
  lineType: JobLineType;
  customerStockEntryId: string;
  irmItemId: string;
  itemName: string;
  seCode: string;
  description: string;
  warehouseId: string;
  warehouseName: string;
  available: number | null; // IRM on-hand at the chosen warehouse (null = not loaded / N/A)
  loadingAvail: boolean;
  qty: string;
  notes: string;
};

const newKitLine = (): KitLine => ({
  _key: crypto.randomUUID(),
  lineType: "misc",
  customerStockEntryId: "",
  irmItemId: "",
  itemName: "",
  seCode: "",
  description: "",
  warehouseId: "",
  warehouseName: "",
  available: null,
  loadingAvail: false,
  qty: "1",
  notes: "",
});

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">{message}</p>;
}

// Vertical step wrapper: a numbered FormSection. Steps stack in the left column.
function Step({ n, title, description, children }: { n: number; title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="relative pl-11">
      <span className="absolute left-0 top-5 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent-10)] text-xs font-extrabold text-[var(--accent)]">{n}</span>
      <FormSection title={title} description={description}>{children}</FormSection>
    </div>
  );
}

export function JobForm({ mode, job }: { mode: "create" | "edit"; job?: Job | null }) {
  const router = useRouter();
  const guard = useNavigationGuard();
  const { pushToast } = useDashboard();

  const o = job;

  // --- Step 1: Identification ---
  const [name, setName] = React.useState(o?.name ?? "");
  const [customerRef, setCustomerRef] = React.useState(o?.customerRef ?? "");
  const [schemeNo, setSchemeNo] = React.useState(o?.schemeNo ?? "");
  const [jobType, setJobType] = React.useState(o?.jobType ?? "installation");
  const [technology, setTechnology] = React.useState(o?.technology ?? "");
  const [priority, setPriority] = React.useState(o?.priority ?? "normal");

  // --- Step 2: Customer & Project ---
  const [customerId, setCustomerId] = React.useState(o?.customerId ?? "");
  const [projectId, setProjectId] = React.useState(o?.projectId ?? "");

  // --- Step 3: Site / Location ---
  const [siteId, setSiteId] = React.useState(o?.siteId ?? "");
  const [siteName, setSiteName] = React.useState(o?.siteName ?? "");
  const [trsArea, setTrsArea] = React.useState(o?.trsArea ?? "");
  const [address, setAddress] = React.useState(o?.address ?? "");
  const [postcode, setPostcode] = React.useState(o?.postcode ?? "");
  const [floor, setFloor] = React.useState(o?.floor ?? "");
  const [suite, setSuite] = React.useState(o?.suite ?? "");
  const [rack, setRack] = React.useState(o?.rack ?? "");
  const [shelf, setShelf] = React.useState(o?.shelf ?? "");

  // --- Step 4: Schedule & Engineer ---
  const [completionDate, setCompletionDate] = React.useState(o ? dateInput(o.completionDate) : "");
  const [assignedEngineerId, setAssignedEngineerId] = React.useState(o?.assignedEngineerId ?? "");
  const [installerType, setInstallerType] = React.useState(o?.installerType ?? "internal");
  const [supplierId, setSupplierId] = React.useState(o?.supplierId ?? "");
  const [plannerName, setPlannerName] = React.useState(o?.plannerName ?? "");
  const [plannerPhone, setPlannerPhone] = React.useState(o?.plannerPhone ?? "");

  // --- Step 5: Kit list ---
  const [kitLines, setKitLines] = React.useState<KitLine[]>(() =>
    o && o.kitLines.length > 0
      ? o.kitLines.map((l) => ({
          _key: crypto.randomUUID(),
          lineType: l.lineType,
          customerStockEntryId: l.customerStockEntryId ?? "",
          irmItemId: l.irmItemId ?? "",
          itemName: l.itemName,
          seCode: l.seCode ?? "",
          description: l.description ?? "",
          warehouseId: l.warehouseId ?? "",
          warehouseName: l.warehouseName ?? "",
          available: null,
          loadingAvail: false,
          qty: String(l.qty),
          notes: l.notes ?? "",
        }))
      : [newKitLine()],
  );

  // --- Step 6: Attachments & notes ---
  const [attachments, setAttachments] = React.useState<string[]>(() => (o && o.attachments.length > 0 ? [...o.attachments] : [""]));
  const [notes, setNotes] = React.useState(o?.notes ?? "");

  // --- reference data ---
  const [customers, setCustomers] = React.useState<Opt[]>([]);
  const [projects, setProjects] = React.useState<CustomerProject[]>([]);
  const [sites, setSites] = React.useState<CustomerSite[]>([]);
  const [loadingProjects, setLoadingProjects] = React.useState(false);
  const [engineers, setEngineers] = React.useState<{ id: string; name: string; jobTitle: string | null }[]>([]);
  const [suppliers, setSuppliers] = React.useState<Opt[]>([]);
  const [irmItems, setIrmItems] = React.useState<Opt[]>([]);
  const [warehouses, setWarehouses] = React.useState<WarehouseOption[]>([]);
  const [stockEntries, setStockEntries] = React.useState<CustomerStockEntry[]>([]);

  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const touch = () => setDirty(true);
  const clearError = (f: string) => setErrors((p) => { if (!p[f]) return p; const n = { ...p }; delete n[f]; return n; });
  useReportDirty("job-form", dirty && !saved);

  // Static reference lists (one effect, active-guarded).
  React.useEffect(() => {
    let active = true;
    listCustomers({ status: "active", pageSize: 200 }).then((r) => active && setCustomers(r.customers.map((c) => ({ value: c.id, label: c.name }))), () => {});
    listManagerOptions().then((us) => active && setEngineers(us.map((u) => ({ id: u.id, name: u.name, jobTitle: u.jobTitle }))), () => {});
    listSuppliers({ status: "active", pageSize: 200 }).then((r) => active && setSuppliers(r.suppliers.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` }))), () => {});
    listIrmItems({ status: "active", pageSize: 200 }).then((r) => active && setIrmItems(r.items.map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` }))), () => {});
    listWarehouseOptions().then((ws) => active && setWarehouses(ws), () => {});
    return () => { active = false; };
  }, []);

  // Projects, sites + customer-stock catalogue depend on the chosen customer. One effect,
  // keyed on customerId, so it covers BOTH edit-mode seeding (customerId arrives from `o`)
  // AND user changes (onPickCustomer sets customerId). Every setState happens inside an
  // async callback — never synchronously in the effect body (react-hooks/set-state-in-effect).
  React.useEffect(() => {
    if (!customerId) return;
    let active = true;
    getCustomer(customerId).then(
      (c) => { if (active) { setProjects(c.projects ?? []); setSites(c.sites ?? []); setLoadingProjects(false); } },
      () => { if (active) { setProjects([]); setSites([]); setLoadingProjects(false); } },
    );
    listCustomerStockEntries(customerId, "active").then(
      (rows) => { if (active) setStockEntries(rows); },
      () => { if (active) setStockEntries([]); },
    );
    return () => { active = false; };
  }, [customerId]);

  // Edit mode: once warehouses are loaded, backfill the IRM availability hint for already-populated
  // irm lines (seeded with available:null) so the "N available / short" signal shows without the PM
  // re-touching a dropdown. One-time (ref-guarded); every setState is inside an async callback.
  const availSeeded = React.useRef(false);
  React.useEffect(() => {
    if (availSeeded.current || warehouses.length === 0) return;
    availSeeded.current = true;
    let active = true;
    for (const l of kitLines) {
      if (l.lineType !== "irm" || !l.irmItemId || !l.warehouseId || l.available != null) continue;
      const { _key, irmItemId, warehouseId } = l;
      getAvailability(irmItemId, warehouseId).then(
        (a) => { if (active) setKitLines((rows) => rows.map((r) => (r._key === _key && r.irmItemId === irmItemId && r.warehouseId === warehouseId ? { ...r, available: a.available } : r))); },
        () => {},
      );
    }
    return () => { active = false; };
  }, [warehouses, kitLines]);

  const onPickCustomer = (id: string) => {
    // Customer change invalidates project/site/customer-stock selections; the effect above
    // then reloads the new customer's projects/sites/stock.
    setProjects([]);
    setSites([]);
    setStockEntries([]);
    setLoadingProjects(Boolean(id));
    setCustomerId(id);
    setProjectId("");
    setSiteId("");
    setKitLines((rows) => rows.map((r) => (r.lineType === "customer_stock" ? { ...r, customerStockEntryId: "", itemName: "", seCode: "", warehouseId: "", warehouseName: "", available: null } : r)));
    touch();
    clearError("customerId");
    clearError("projectId");
  };

  // --- kit-line helpers ---
  const setLine = (key: string, patch: Partial<KitLine>) => setKitLines((rows) => rows.map((r) => (r._key === key ? { ...r, ...patch } : r)));
  const addLine = () => { setKitLines((rows) => [...rows, newKitLine()]); touch(); };
  const removeLine = (key: string) => { setKitLines((rows) => (rows.length === 1 ? rows : rows.filter((r) => r._key !== key))); touch(); };

  const onPickLineType = (key: string, lineType: JobLineType) => {
    // Reset the item-identity + warehouse fields when the line type changes.
    setLine(key, { lineType, customerStockEntryId: "", irmItemId: "", itemName: "", seCode: "", warehouseId: "", warehouseName: "", available: null, loadingAvail: false });
    touch();
    clearError("kitLines");
  };

  const onPickStockEntry = (key: string, entryId: string) => {
    // Customer stock physically lives at one warehouse — derive it from the chosen entry.
    const e = stockEntries.find((x) => x.id === entryId) ?? null;
    setLine(key, {
      customerStockEntryId: entryId,
      itemName: e?.itemName ?? "",
      seCode: e?.sku ?? "",
      warehouseId: e?.warehouseId ?? "",
      warehouseName: e?.warehouseName ?? "",
      available: e ? e.quantity : null,
      loadingAvail: false,
    });
    touch();
    clearError("kitLines");
  };

  // IRM on-hand at the chosen warehouse — the "can the engineer actually pick it" signal. The
  // resolver re-checks the line STILL has this exact item+warehouse before applying, so a slow
  // earlier request can't overwrite a newer selection (last-write-wins race) and a changed line is
  // left alone.
  const loadAvailability = (key: string, irmItemId: string, warehouseId: string) => {
    if (!irmItemId || !warehouseId) { setLine(key, { available: null, loadingAvail: false }); return; }
    setLine(key, { loadingAvail: true });
    const applyIfCurrent = (available: number | null) =>
      setKitLines((rows) => rows.map((r) => (r._key === key && r.irmItemId === irmItemId && r.warehouseId === warehouseId ? { ...r, available, loadingAvail: false } : r)));
    getAvailability(irmItemId, warehouseId).then((a) => applyIfCurrent(a.available), () => applyIfCurrent(null));
  };

  const onPickIrmItem = (key: string, itemId: string) => {
    const i = irmItems.find((x) => x.value === itemId) ?? null;
    const line = kitLines.find((x) => x._key === key);
    setLine(key, { irmItemId: itemId, itemName: i?.label ?? "" });
    loadAvailability(key, itemId, line?.warehouseId ?? "");
    touch();
    clearError("kitLines");
  };

  const onPickLineWarehouse = (key: string, warehouseId: string) => {
    const w = warehouses.find((x) => x.id === warehouseId) ?? null;
    const line = kitLines.find((x) => x._key === key);
    // Bare name to match the server snapshot + detail tables (the code lives in the picker label).
    setLine(key, { warehouseId, warehouseName: w ? w.name : "" });
    loadAvailability(key, line?.irmItemId ?? "", warehouseId);
    touch();
    clearError("kitLines");
  };

  // --- attachments helpers ---
  const setAttachment = (i: number, v: string) => { setAttachments((rows) => rows.map((r, idx) => (idx === i ? v : r))); touch(); };
  const addAttachment = () => { setAttachments((rows) => [...rows, ""]); touch(); };
  const removeAttachment = (i: number) => { setAttachments((rows) => (rows.length === 1 ? rows : rows.filter((_, idx) => idx !== i))); touch(); };

  const lineIsValid = (l: KitLine): boolean => {
    if (num(l.qty) < 1) return false;
    if (l.lineType === "misc") return Boolean(l.itemName.trim());
    if (l.lineType === "customer_stock") return Boolean(l.customerStockEntryId);
    return Boolean(l.irmItemId && l.warehouseId); // irm needs the item AND a pickup warehouse
  };

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Job name is required.";
    if (!customerId) e.customerId = "Select a customer.";
    if (!projectId) e.projectId = "Select a project.";
    if (!assignedEngineerId) e.assignedEngineerId = "Assign an engineer.";
    const active = kitLines.filter(lineIsValid);
    if (active.length === 0) e.kitLines = "Add at least one kit line (a quantity, and an item or a name).";
    return e;
  };

  const buildPayload = (): jobService.JobPayload => ({
    name: name.trim(),
    customerRef: customerRef.trim() || undefined,
    schemeNo: schemeNo.trim() || undefined,
    jobType: jobType || undefined,
    technology: technology.trim() || undefined,
    priority: priority || undefined,
    customerId,
    projectId,
    siteId: siteId || undefined,
    siteName: siteName.trim() || undefined,
    trsArea: trsArea.trim() || undefined,
    address: address.trim() || undefined,
    postcode: postcode.trim() || undefined,
    floor: floor.trim() || undefined,
    suite: suite.trim() || undefined,
    rack: rack.trim() || undefined,
    shelf: shelf.trim() || undefined,
    completionDate: completionDate || undefined,
    assignedEngineerId,
    installerType: installerType || undefined,
    supplierId: supplierId || undefined,
    plannerName: plannerName.trim() || undefined,
    plannerPhone: plannerPhone.trim() || undefined,
    notes: notes.trim() || undefined,
    attachments: attachments.map((a) => a.trim()).filter(Boolean),
    kitLines: kitLines.filter(lineIsValid).map((l) => ({
      lineType: l.lineType,
      itemName: l.lineType === "misc" ? l.itemName.trim() : (l.itemName.trim() || l.seCode.trim() || "Item"),
      seCode: l.seCode.trim() || undefined,
      description: l.description.trim() || undefined,
      customerStockEntryId: l.lineType === "customer_stock" ? l.customerStockEntryId : undefined,
      irmItemId: l.lineType === "irm" ? l.irmItemId : undefined,
      // customer_stock warehouse is derived server-side from the entry; irm sends the chosen warehouse.
      warehouseId: l.lineType === "irm" ? l.warehouseId || undefined : undefined,
      qty: num(l.qty),
      notes: l.notes.trim() || undefined,
    })),
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setError(null);
    const fieldErrors = validate();
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      pushToast("Please fix the highlighted fields.", "alert");
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      if (mode === "create") {
        const created = await jobService.createJob(buildPayload());
        setSaved(true);
        pushToast(`Job ${created.jobNumber} created.`, "success");
        router.replace(`${JOBS_LIST}/${created.jobNumber}`);
      } else if (o) {
        const updated = await jobService.updateJob(o.id, buildPayload());
        setSaved(true);
        pushToast("Job updated.", "success");
        router.replace(`${JOBS_LIST}/${updated.jobNumber}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save the job.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false);
    }
  };

  const goBack = () => guard.attemptLeave(() => router.push(JOBS_LIST));

  const engineerLabel = (s: { name: string; jobTitle: string | null }) => (s.jobTitle ? `${s.name} — ${s.jobTitle}` : s.name);
  const validLines = kitLines.filter(lineIsValid);
  const totalUnits = validLines.reduce((a, l) => a + num(l.qty), 0);
  const customerName = customers.find((c) => c.value === customerId)?.label;
  const engineerName = engineers.find((s) => s.id === assignedEngineerId)?.name;
  const projectName = projects.find((p) => p.id === projectId)?.name;

  return (
    <form onSubmit={submit} className="space-y-6">
      <FormPageHeader
        title={mode === "create" ? "New job" : `Edit ${o?.jobNumber ?? "job"}`}
        subtitle={mode === "edit" && o ? o.jobNumber : "Create, schedule and assign a job to an engineer"}
        onBack={goBack}
        actions={
          <>
            <button type="button" onClick={goBack} disabled={saving} className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-5 py-2.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-60">Cancel</button>
            <button type="submit" disabled={saving} className="flex items-center gap-2 rounded-xl bg-[var(--accent)] px-5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {mode === "create" ? "Create & assign" : "Save changes"}
            </button>
          </>
        }
      />

      {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* LEFT: vertical stacked steps */}
        <div className="space-y-6 lg:col-span-2">
          {/* Step 1 — Identification */}
          <Step n={1} title="Identification" description="What the job is.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>Job name<RequiredMark /></label>
                <input className={inputCls} value={name} onChange={(e) => { setName(e.target.value); touch(); clearError("name"); }} maxLength={200} placeholder="e.g. Leeds Basinghall — rack build" aria-required aria-invalid={Boolean(errors.name)} />
                <FieldError message={errors.name} />
              </div>
              <div>
                <label className={labelCls}>Customer reference</label>
                <input className={inputCls} value={customerRef} onChange={(e) => { setCustomerRef(e.target.value); touch(); }} maxLength={120} placeholder="Optional" />
              </div>
              <div>
                <label className={labelCls}>Scheme number</label>
                <input className={inputCls} value={schemeNo} onChange={(e) => { setSchemeNo(e.target.value); touch(); }} maxLength={120} placeholder="Optional" />
              </div>
              <div>
                <label className={labelCls}>Job type</label>
                <Select value={jobType} onChange={(v) => { setJobType(v); touch(); }} options={JOB_TYPES.map((t) => ({ value: t, label: JOB_TYPE_LABELS[t] }))} ariaLabel="Job type" />
              </div>
              <div>
                <label className={labelCls}>Priority</label>
                <Select value={priority} onChange={(v) => { setPriority(v); touch(); }} options={JOB_PRIORITIES.map((p) => ({ value: p, label: JOB_PRIORITY_LABELS[p] }))} ariaLabel="Priority" />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Technology</label>
                <input className={inputCls} value={technology} onChange={(e) => { setTechnology(e.target.value); touch(); }} maxLength={120} placeholder="e.g. Fibre, Copper, Wireless" />
              </div>
            </div>
          </Step>

          {/* Step 2 — Customer & Project */}
          <Step n={2} title="Customer & project" description="Who the job is for.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Customer<RequiredMark /></label>
                <Select value={customerId} onChange={onPickCustomer} options={customers} placeholder="— Select customer —" ariaLabel="Customer" invalid={Boolean(errors.customerId)} />
                <FieldError message={errors.customerId} />
              </div>
              <div>
                <label className={labelCls}>Project<RequiredMark /></label>
                <Select value={projectId} onChange={(v) => { setProjectId(v); touch(); clearError("projectId"); }} options={projects.map((p) => ({ value: p.id, label: p.code ? `${p.code} — ${p.name}` : p.name }))} placeholder={customerId ? (loadingProjects ? "Loading…" : "— Select project —") : "Pick a customer first"} disabled={!customerId || loadingProjects} ariaLabel="Project" invalid={Boolean(errors.projectId)} />
                <FieldError message={errors.projectId} />
                {customerId && !loadingProjects && projects.length === 0 && <p className="mt-1.5 text-[11px] text-[var(--faint)]">This customer has no projects yet.</p>}
              </div>
            </div>
          </Step>

          {/* Step 3 — Site / Location */}
          <Step n={3} title="Site & location" description="Where the work happens. Pick a saved site or enter the address manually.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>Site</label>
                <Select value={siteId} onChange={(v) => { setSiteId(v); touch(); }} options={[{ value: "", label: "— None / enter manually —" }, ...sites.map((s) => ({ value: s.id, label: s.code ? `${s.code} — ${s.name}` : s.name }))]} placeholder={customerId ? "— Select site —" : "Pick a customer first"} disabled={!customerId} ariaLabel="Site" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Choose a saved customer site, or leave as “None” and fill in the address below.</p>
              </div>
              <div>
                <label className={labelCls}>Site name</label>
                <input className={inputCls} value={siteName} onChange={(e) => { setSiteName(e.target.value); touch(); }} maxLength={200} placeholder="Optional" />
              </div>
              <div>
                <label className={labelCls}>TRS area</label>
                <input className={inputCls} value={trsArea} onChange={(e) => { setTrsArea(e.target.value); touch(); }} maxLength={120} placeholder="Optional" />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Address</label>
                <input className={inputCls} value={address} onChange={(e) => { setAddress(e.target.value); touch(); }} maxLength={300} placeholder="Street address" />
              </div>
              <PostcodeField value={postcode} onChange={(v) => { setPostcode(v); touch(); }} setCity={() => {}} required={false} />
              <div className="grid grid-cols-2 gap-4 sm:col-span-2 sm:grid-cols-4">
                <div>
                  <label className={labelCls}>Floor</label>
                  <input className={inputCls} value={floor} onChange={(e) => { setFloor(e.target.value); touch(); }} maxLength={60} placeholder="Optional" />
                </div>
                <div>
                  <label className={labelCls}>Suite</label>
                  <input className={inputCls} value={suite} onChange={(e) => { setSuite(e.target.value); touch(); }} maxLength={60} placeholder="Optional" />
                </div>
                <div>
                  <label className={labelCls}>Rack</label>
                  <input className={inputCls} value={rack} onChange={(e) => { setRack(e.target.value); touch(); }} maxLength={60} placeholder="Optional" />
                </div>
                <div>
                  <label className={labelCls}>Shelf</label>
                  <input className={inputCls} value={shelf} onChange={(e) => { setShelf(e.target.value); touch(); }} maxLength={60} placeholder="Optional" />
                </div>
              </div>
            </div>
          </Step>

          {/* Step 4 — Schedule & Engineer */}
          <Step n={4} title="Schedule & engineer" description="When it should be done and who does it. The assigned engineer is notified instantly.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Completion date</label>
                <input type="date" className={inputCls} value={completionDate} onChange={(e) => { setCompletionDate(e.target.value); touch(); }} />
              </div>
              <div>
                <label className={labelCls}>Assigned engineer<RequiredMark /></label>
                <Select value={assignedEngineerId} onChange={(v) => { setAssignedEngineerId(v); touch(); clearError("assignedEngineerId"); }} options={engineers.map((s) => ({ value: s.id, label: engineerLabel(s) }))} placeholder="— Select engineer —" ariaLabel="Assigned engineer" invalid={Boolean(errors.assignedEngineerId)} />
                <FieldError message={errors.assignedEngineerId} />
              </div>
              <div>
                <label className={labelCls}>Installer type</label>
                <Select value={installerType} onChange={(v) => { setInstallerType(v); touch(); }} options={INSTALLER_TYPES.map((t) => ({ value: t, label: INSTALLER_TYPE_LABELS[t] }))} ariaLabel="Installer type" />
              </div>
              <div>
                <label className={labelCls}>Supplier</label>
                <Select value={supplierId} onChange={(v) => { setSupplierId(v); touch(); }} options={[{ value: "", label: "— None —" }, ...suppliers]} placeholder="— None —" ariaLabel="Supplier" />
              </div>
              <div>
                <label className={labelCls}>Planner name</label>
                <input className={inputCls} value={plannerName} onChange={(e) => { setPlannerName(e.target.value); touch(); }} maxLength={120} placeholder="Optional" />
              </div>
              <div>
                <label className={labelCls}>Planner phone</label>
                <input className={inputCls} value={plannerPhone} onChange={(e) => { setPlannerPhone(e.target.value); touch(); }} maxLength={60} placeholder="Optional" />
              </div>
            </div>
          </Step>

          {/* Step 5 — Kit list */}
          <Step n={5} title="Kit list" description="What the engineer takes — customer stock, IRM stock, or a free-text item.">
            <div className="space-y-3">
              {kitLines.map((l) => (
                <div key={l._key} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                    <div className="min-w-0 sm:col-span-6 lg:col-span-3">
                      <label className={labelCls}>Source</label>
                      <Select value={l.lineType} onChange={(v) => onPickLineType(l._key, v as JobLineType)} options={JOB_LINE_TYPES.map((t) => ({ value: t, label: JOB_LINE_TYPE_LABELS[t] }))} ariaLabel="Line source" />
                    </div>
                    <div className="min-w-0 sm:col-span-6 lg:col-span-4">
                      <label className={labelCls}>Item</label>
                      {l.lineType === "customer_stock" ? (
                        !customerId ? (
                          <p className="flex h-[42px] items-center truncate rounded-xl border border-dashed border-[var(--border)] px-3 text-[11px] text-[var(--faint)]">Pick a customer in step 2 first.</p>
                        ) : (
                          <Select value={l.customerStockEntryId} onChange={(v) => onPickStockEntry(l._key, v)} options={stockEntries.map((e) => ({ value: e.id, label: `${e.sku ? `${e.sku} — ` : ""}${e.itemName}${e.warehouseName ? ` · ${e.warehouseName}` : ""}` }))} placeholder="— Select customer stock —" ariaLabel="Customer stock item" />
                        )
                      ) : l.lineType === "irm" ? (
                        <Select value={l.irmItemId} onChange={(v) => onPickIrmItem(l._key, v)} options={irmItems} placeholder="— Select IRM item —" ariaLabel="IRM item" />
                      ) : (
                        <input className={inputCls} value={l.itemName} onChange={(e) => { setLine(l._key, { itemName: e.target.value }); touch(); clearError("kitLines"); }} maxLength={200} placeholder="Item name" />
                      )}
                    </div>
                    <div className="min-w-0 sm:col-span-8 lg:col-span-3">
                      <label className={labelCls}>Warehouse{l.lineType === "irm" ? <RequiredMark /> : null}</label>
                      {l.lineType === "irm" ? (
                        <Select value={l.warehouseId} onChange={(v) => onPickLineWarehouse(l._key, v)} options={warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` }))} placeholder="— Pick warehouse —" ariaLabel="Pickup warehouse" />
                      ) : l.lineType === "customer_stock" ? (
                        <div className="flex h-[42px] items-center rounded-xl border border-dashed border-[var(--border)] px-3" title={l.warehouseName || undefined}>
                          <span className="truncate text-[11px] text-[var(--muted)]">{l.warehouseName || "From the stock entry"}</span>
                        </div>
                      ) : (
                        <div className="flex h-[42px] items-center rounded-xl border border-dashed border-[var(--border)] px-3 text-[11px] text-[var(--faint)]">—</div>
                      )}
                    </div>
                    <div className="min-w-0 sm:col-span-4 lg:col-span-2">
                      <label className={labelCls}>Qty</label>
                      <NumberInput className={inputCls} min={1} step={1} value={l.qty} onChange={(e) => { setLine(l._key, { qty: e.target.value }); touch(); clearError("kitLines"); }} placeholder="1" />
                    </div>
                    <div className="flex items-stretch gap-2 sm:col-span-12">
                      <input className={`${inputCls} min-w-0 flex-1`} value={l.notes} onChange={(e) => { setLine(l._key, { notes: e.target.value }); touch(); }} maxLength={500} placeholder="Line note (optional)" />
                      <button type="button" onClick={() => removeLine(l._key)} disabled={kitLines.length === 1} className="flex w-11 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--neg)] disabled:opacity-40" aria-label="Remove line"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                  {(l.lineType !== "misc" && (l.seCode || l.warehouseId || l.loadingAvail || l.available != null)) && (
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--faint)]">
                      {l.lineType === "customer_stock" && l.seCode && <span>SE code {l.seCode}.</span>}
                      {l.lineType === "customer_stock" && l.available != null && <span>{l.available} in stock.</span>}
                      {l.lineType === "irm" && l.warehouseId && (
                        l.loadingAvail ? (
                          <span>Checking stock…</span>
                        ) : l.available != null ? (
                          <span className={l.available < num(l.qty) ? "font-semibold text-[var(--neg)]" : "text-[var(--pos)]"}>{l.available} available{l.available < num(l.qty) ? " — short for this qty" : ""}.</span>
                        ) : null
                      )}
                    </div>
                  )}
                </div>
              ))}
              <button type="button" onClick={addLine} className="flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-1.5 text-xs font-bold text-[var(--accent)] hover:bg-[var(--surface-2)]"><Plus className="h-3.5 w-3.5" /> Add line</button>
            </div>
            <FieldError message={errors.kitLines} />
          </Step>

          {/* Step 6 — Attachments, notes & review */}
          <Step n={6} title="Attachments, notes & review" description="Reference links, notes, and a final check.">
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Attachment links</label>
                <div className="space-y-2">
                  {attachments.map((a, i) => (
                    <div key={i} className="flex items-stretch gap-2">
                      <input className={`${inputCls} min-w-0 flex-1`} value={a} onChange={(e) => setAttachment(i, e.target.value)} maxLength={500} placeholder="https://…" />
                      <button type="button" onClick={() => removeAttachment(i)} disabled={attachments.length === 1} className="flex w-11 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--neg)] disabled:opacity-40" aria-label="Remove attachment"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  ))}
                  <button type="button" onClick={addAttachment} className="flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-1.5 text-xs font-bold text-[var(--accent)] hover:bg-[var(--surface-2)]"><Plus className="h-3.5 w-3.5" /> Add link</button>
                </div>
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Paste a URL to a document, drawing, or photo. Optional.</p>
              </div>
              <div>
                <label className={labelCls}>Notes</label>
                <textarea className={inputCls} rows={3} value={notes} onChange={(e) => { setNotes(e.target.value); touch(); }} maxLength={2000} placeholder="Anything the engineer should know." />
              </div>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-3 text-[11px] text-[var(--muted)]">
                <p className="mb-1 font-bold uppercase tracking-wider text-[var(--faint)]">Review</p>
                <p>{name.trim() || "Unnamed job"} · {customerName ?? "no customer"} · {projectName ?? "no project"} · {engineerName ?? "no engineer"} · {validLines.length} kit line{validLines.length === 1 ? "" : "s"} ({totalUnits} unit{totalUnits === 1 ? "" : "s"}).</p>
              </div>
            </div>
          </Step>
        </div>

        {/* RIGHT: sticky live summary */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <FormAsideCard title="Job summary">
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between gap-3"><span className="text-[var(--muted)]">Customer</span><span className="text-right font-semibold text-[var(--ink)]">{customerName ?? "—"}</span></div>
              <div className="flex justify-between gap-3"><span className="text-[var(--muted)]">Project</span><span className="text-right font-semibold text-[var(--ink)]">{projectName ?? "—"}</span></div>
              <div className="flex justify-between gap-3"><span className="text-[var(--muted)]">Engineer</span><span className="text-right font-semibold text-[var(--ink)]">{engineerName ?? "—"}</span></div>
              <div className="flex justify-between gap-3"><span className="text-[var(--muted)]">Priority</span><span className="text-right font-semibold text-[var(--ink)]">{JOB_PRIORITY_LABELS[priority as keyof typeof JOB_PRIORITY_LABELS] ?? priority}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted)]">Completion</span><span className="font-semibold text-[var(--ink)]">{completionDate || "—"}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted)]">Kit lines</span><span className="font-semibold text-[var(--ink)]">{validLines.length}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted)]">Total units</span><span className="font-extrabold text-[var(--ink)]">{totalUnits}</span></div>
              <p className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 text-[11px] text-[var(--muted)]">{mode === "create" ? "On save the job is assigned to the engineer, who is notified in real time and accepts it from their portal. The job number is allocated on save." : "Saving updates the job header and replaces the kit list."}</p>
            </div>
          </FormAsideCard>
        </aside>
      </div>
    </form>
  );
}
