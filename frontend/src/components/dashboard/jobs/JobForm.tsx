"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, FileText, Globe, Image as ImageIcon, Link as LinkIcon, Loader2, Lock, Plus, Trash2, Upload } from "lucide-react";

import * as jobService from "@/services/job.service";
import { listCustomerOptions, listCustomerProjects, listCustomerSites, listCustomerStockOptions, type CustomerOption, type CustomerStockOption } from "@/services/customer.service";
import { listEngineerOptions, listWarehouseOptions, type WarehouseOption } from "@/services/warehouse.service";
import { listIrmItems } from "@/services/irm.service";
import { IrmItemPicker } from "@/components/dashboard/irm/IrmItemPicker";
import { mergeIrmItems, missingIrmIds } from "@/components/dashboard/irm/irmItemPickerModel";
import { useReferenceData } from "@/hooks/useReferenceData";
import { useIrmItemsByIds } from "@/hooks/useIrmItemsByIds";
import { useRentalItemsByIds } from "@/hooks/useRentalItemsByIds";
import { RentalItemPicker } from "@/components/dashboard/rentals/RentalItemPicker";
import { mergeById, missingIds } from "@/lib/cataloguePicker";
import { irmKitLineIds, rentalKitLineIds } from "./kitCatalogueIds";
import type { IrmItem } from "@/types/irm";
import type { RentalItem } from "@/types/rental";
import { getAvailability, listItemWarehouseStock } from "@/services/inventory.service";
import { getJobsDemand } from "@/services/goodsManagement.service";
import { getRentalItemAvailability, listRentalItems } from "@/services/rental.service";
import { listSupplierOptions, type SupplierOption } from "@/services/supplier.service";
import { withHistoricalOption } from "@/lib/historicalOption";
import { useDashboard } from "@/hooks/useDashboard";
import { useAuth } from "@/hooks/useAuth";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import { ProjectModal } from "@/components/dashboard/customers/ProjectModal";
import { optionalFor } from "@/lib/formPayload";
import { inputCls, labelCls } from "@/components/ui/styles";
import { FieldError, FormAsideCard, FormPageHeader, FormSection, RequiredMark, SummaryRow } from "@/components/ui/FormScaffold";
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
import type { CustomerProject, CustomerSite } from "@/types/customer";
import type { Job, JobLineType } from "@/types/job";
import { focusFirstInvalid } from "@/lib/focusFirstInvalid";
import { isHttpUrl } from "@/lib/validation";
import { canAddJobAttachment, JOB_ATTACHMENT_MAX, parseJobAttachment } from "./jobAttachment";
import { uploadDirectForUrl } from "@/lib/upload";
import { allowedFrom, BUSINESS_DOC_ACCEPT, BUSINESS_DOC_LABEL, EXT_MEDIA_TYPE, resolveFileType } from "@/lib/uploadPolicy";
import { dropRing, useFileDrop } from "@/hooks/useFileDrop";

// The spreadsheet-capable document policy. A job carries the paperwork the engineer needs on site —
// a schedule, an equipment list, a survey — and those arrive as workbooks as often as PDFs.
const ATTACH_ACCEPT = BUSINESS_DOC_ACCEPT;
const ATTACH_ALLOWED = allowedFrom(ATTACH_ACCEPT);
import { shrinkImage } from "@/lib/image";

const JOBS_LIST = "/dashboard/jobs";
const dateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");
const num = (s: string) => Number(s) || 0;

type Opt = { value: string; label: string };
// Resolution of "which warehouses stock this IRM item": loading (fetch in flight), ready (fetched —
// `options` may be empty, meaning the item is stocked nowhere), or error (lookup failed / no
// inventory permission — caller falls back to the full warehouse list).
type IrmWarehouseLookup = { status: "loading" | "ready" | "error"; options: Opt[] };
type KitLine = {
  _key: string;
  lineType: JobLineType;
  customerStockEntryId: string;
  // The chosen customer-stock item, identity-only (sku + name). One logical item can sit in
  // several warehouses, so the item is picked first and the warehouse second; this holds the
  // item selection while the line still has no warehouse (hence no concrete entry id) yet.
  customerStockItemKey: string;
  irmItemId: string;
  rentalItemId: string;
  itemName: string;
  seCode: string;
  description: string;
  warehouseId: string;
  warehouseName: string;
  available: number | null; // IRM on-hand at the chosen warehouse (null = not loaded / N/A)
  loadingAvail: boolean;
  qty: string;
  notes: string;
  issued: number; // qty already issued to the engineer — >0 ⇒ line is LOCKED (item/warehouse fixed,
  lockedQty: number; // qty can only increase from this; can't be removed). lockedQty = planned-at-edit.
};

// Identity of a customer-stock item across warehouses: sku (when present) + display name. Used to
// collapse the per-warehouse stock entries into one pickable item, and to re-derive the selection
// in edit mode (where only seCode + itemName survive on the saved line).
// The separator is an ESCAPED NUL, never a raw 0x00 byte. A raw one makes git treat this whole
// file as binary -- no diff, no blame, no reviewable history on the biggest form in the app -- and
// most editors render it as nothing, so one reformat or copy/paste silently drops it and keys for
// different items begin colliding. Same string at runtime; keep it escaped.
const stockItemKey = (sku: string | null | undefined, itemName: string) => `${sku ?? ""}\u0000${itemName}`;

const newKitLine = (): KitLine => ({
  _key: crypto.randomUUID(),
  lineType: "misc",
  customerStockEntryId: "",
  customerStockItemKey: "",
  irmItemId: "",
  rentalItemId: "",
  itemName: "",
  seCode: "",
  description: "",
  warehouseId: "",
  warehouseName: "",
  available: null,
  loadingAvail: false,
  qty: "1",
  notes: "",
  issued: 0,
  lockedQty: 0,
});

// Vertical step wrapper: a numbered FormSection. Steps stack in the left column.
// `title` is a ReactNode (FormSection's own type) so a step can carry a RequiredMark — the Kit list
// step is mandatory as a whole (≥1 line), which no single field label can express.
function Step({ n, title, description, children }: { n: number; title: React.ReactNode; description?: string; children: React.ReactNode }) {
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
  const { can } = useAuth();

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
  const [showProjectModal, setShowProjectModal] = React.useState(false); // inline "Add project"
  const canCreateProject = can("customer_projects.create");

  // --- Step 3: Site / Location ---
  const [siteId, setSiteId] = React.useState(o?.siteId ?? "");
  const [siteName, setSiteName] = React.useState(o?.siteName ?? "");
  const [trsArea, setTrsArea] = React.useState(o?.trsArea ?? "");
  const [addressLine1, setAddressLine1] = React.useState(o?.addressLine1 ?? "");
  const [addressLine2, setAddressLine2] = React.useState(o?.addressLine2 ?? "");
  const [city, setCity] = React.useState(o?.city ?? "");
  const [county, setCounty] = React.useState(o?.county ?? "");
  const [postcode, setPostcode] = React.useState(o?.postcode ?? "");
  const [country, setCountry] = React.useState(o?.country ?? (o ? "" : "United Kingdom"));
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
          customerStockItemKey: l.lineType === "customer_stock" ? stockItemKey(l.seCode, l.itemName) : "",
          irmItemId: l.irmItemId ?? "",
          rentalItemId: l.rentalItemId ?? "",
          itemName: l.itemName,
          seCode: l.seCode ?? "",
          description: l.description ?? "",
          warehouseId: l.warehouseId ?? "",
          warehouseName: l.warehouseName ?? "",
          available: null,
          loadingAvail: false,
          qty: String(l.qty),
          notes: l.notes ?? "",
          issued: l.issued ?? 0, // lock already-issued lines
          lockedQty: l.qty,
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
  // Open demand (planned-but-not-issued) from OTHER active jobs, keyed by item+warehouse / entry — so
  // "available" in the kit list reflects TRUE free stock across all jobs, not just this one.
  const [demand, setDemand] = React.useState<Map<string, number>>(new Map());
  const [engineers, setEngineers] = React.useState<{ id: string; name: string; jobTitle: string | null }[]>([]);
  const [suppliers, setSuppliers] = React.useState<Opt[]>([]);
  const [irmItems, setIrmItems] = React.useState<IrmItem[]>([]);
  // Kit lines store a display label alongside the id. Keep the shape they have always used
  // ("IRM-0004 — CAT6 Cable") so existing saved kits and new ones read identically.
  const irmKitLabel = (i: IrmItem) => `${i.code} — ${i.name}`;
  // EDIT: a saved kit can name items outside the page loaded at mount. Resolve them by id in ONE
  // request — a kit with twenty IRM lines must not become twenty lookups — so each line's picker
  // shows the item it actually holds instead of reading as empty.
  const resolvingIrmItems = useIrmItemsByIds(
    missingIrmIds(irmKitLineIds(kitLines), irmItems),
    (found) => setIrmItems((prev) => mergeIrmItems(prev, found)),
  );
  const [warehouses, setWarehouses] = React.useState<WarehouseOption[]>([]);
  // The lean OPTION shape, not the full entry row. Typing it as the entry made it natural to feed
  // from the paged list read, which capped the picker at 100 and — because the grouping SUMS
  // quantities per warehouse — silently understated the cap this form enforces.
  const [stockEntries, setStockEntries] = React.useState<CustomerStockOption[]>([]);
  // Cache of warehouses that hold a given IRM item (id → resolution), so the kit picker's warehouse
  // dropdown only offers sites that actually stock the item. Lazily filled when an item is picked.
  // The status matters: "ready" with an EMPTY list means the item is stocked nowhere (show that, do
  // NOT fall back to every warehouse — they'd be misleading); only "error" (lookup failed / no
  // inventory permission) falls back to the full warehouse list so the pick is never hard-blocked.
  const [irmItemWarehouses, setIrmItemWarehouses] = React.useState<Record<string, IrmWarehouseLookup>>({});
  // The authoritative rows, not a `{value,label}` adapter: the picker seeds from these, resolves the
  // selected one from them, and the kit line's label is derived below — one shape, no second copy.
  const [rentalItems, setRentalItems] = React.useState<RentalItem[]>([]);
  // Kit lines store a display label alongside the id. Keep the shape they have always used
  // ("RNT-0005 — Fibre Tester") so existing saved kits and new ones read identically.
  const rentalKitLabel = (i: RentalItem) => `${i.code} — ${i.name}`;
  // EDIT: a saved kit can name a hired item outside the page loaded at mount, which used to render
  // as an EMPTY picker on a line that is in fact set — and re-picking it silently clears the depot
  // and availability. Resolved by exact id, all of them in ONE request.
  const resolvingRentalItems = useRentalItemsByIds(
    missingIds(rentalKitLineIds(kitLines), rentalItems),
    (found) => setRentalItems((prev) => mergeById(prev, found)),
  );
  // The rental twin of irmItemWarehouses. A hired item has no stock level of its own, so "where can
  // this be collected" is answered by its live hires — the server sums them per depot and omits any
  // depot with nothing free, so a "ready" empty list means "hired nowhere with a spare unit".
  const [rentalItemWarehouses, setRentalItemWarehouses] = React.useState<Record<string, IrmWarehouseLookup>>({});
  // Free units per rental item × warehouse, from the same fetch — the planner's qty cap, so the form
  // cannot promise an engineer a tester that is already out on another job.
  const [rentalAvail, setRentalAvail] = React.useState<Map<string, number>>(new Map());

  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const touch = () => setDirty(true);
  const clearError = (f: string) => setErrors((p) => { if (!p[f]) return p; const n = { ...p }; delete n[f]; return n; });
  useReportDirty("job-form", dirty && !saved);

  // Static reference lists. Through `useReferenceData` rather than a hand-rolled effect, for the
  // reason that helper exists: the `() => {}` this replaces swallowed EVERY failure, so a role
  // holding jobs.create without the read permission behind one of these lists saw a silently empty
  // dropdown and no way to find out why. Now each failure raises one toast, naming the list and
  // saying plainly when it is a permission wall.
  const { isLoading: refLoading } = useReferenceData([
    // COMPLETE active sets, lean. A paged read hid every record past the page AND rendered an
    // already-saved one as "none selected" — see listCustomerOptions / listSupplierOptions.
    { label: "customers", load: listCustomerOptions, onData: (os: CustomerOption[]) => setCustomers(os.map((c) => ({ value: c.id, label: c.name }))) },
    { label: "engineers", load: listEngineerOptions, onData: (us: Awaited<ReturnType<typeof listEngineerOptions>>) => setEngineers(us.map((u) => ({ id: u.id, name: u.name, jobTitle: u.jobTitle }))) },
    { label: "suppliers", load: listSupplierOptions, onData: (os: SupplierOption[]) => setSuppliers(os.map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` }))) },
    // A bounded FIRST PAGE for the picker to show before anything is typed; it searches the rest of
    // the catalogue server-side, so a kit can name an item past this page. 100, not 200: `paginate`
    // clamps an ordinary list request to 100, so asking for more quietly returned half of what the
    // number here claimed.
    { label: "the item catalogue", load: () => listIrmItems({ status: "active", pageSize: 100 }), onData: (r) => setIrmItems(r.items) },
    { label: "the rental catalogue", load: () => listRentalItems({ status: "active", pageSize: 100 }), onData: (r) => setRentalItems(r.items) },
    { label: "warehouses", load: listWarehouseOptions, onData: (ws: WarehouseOption[]) => setWarehouses(ws) },
  ]);

  // Projects, sites + customer-stock catalogue depend on the chosen customer. One effect,
  // keyed on customerId, so it covers BOTH edit-mode seeding (customerId arrives from `o`)
  // AND user changes (onPickCustomer sets customerId). Every setState happens inside an
  // async callback — never synchronously in the effect body (react-hooks/set-state-in-effect).
  React.useEffect(() => {
    if (!customerId) return;
    let active = true;
    // Project/site pickers — paged endpoints with the app-wide picker cap (the customer detail
    // payload no longer carries the child sets).
    Promise.all([
      listCustomerProjects(customerId, { pageSize: 100 }),
      listCustomerSites(customerId, { pageSize: 100 }),
    ]).then(
      ([p, s]) => { if (active) { setProjects(p.projects); setSites(s.sites); setLoadingProjects(false); } },
      () => { if (active) { setProjects([]); setSites([]); setLoadingProjects(false); } },
    );
    listCustomerStockOptions(customerId).then(
      (rows) => {
        if (!active) return;
        setStockEntries(rows);
        // Edit mode: customer-stock lines are seeded with available=null (only IRM lines get the
        // getAvailability backfill). Fill their availability from the entry's current quantity so the
        // qty cap fires for customer stock too — matched by the concrete entry id (per warehouse).
        setKitLines((prev) => prev.map((l) =>
          l.lineType === "customer_stock" && l.customerStockEntryId && l.available == null
            ? { ...l, available: rows.find((e) => e.id === l.customerStockEntryId)?.quantity ?? null }
            : l,
        ));
      },
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

  // Load cross-job demand once (excluding THIS job in edit mode, so its own plan isn't double-counted).
  React.useEffect(() => {
    let active = true;
    getJobsDemand(o?.id).then(
      (rows) => {
        if (!active) return;
        const m = new Map<string, number>();
        for (const d of rows) {
          const k = d.irmItemId
            ? `irm|${d.irmItemId}|${d.warehouseId}`
            : d.rentalItemId
              ? `rental|${d.rentalItemId}|${d.warehouseId}`
              : d.customerStockEntryId
                ? `cse|${d.customerStockEntryId}`
                : null;
          if (k) m.set(k, (m.get(k) ?? 0) + d.demand);
        }
        setDemand(m);
      },
      () => {},
    );
    return () => { active = false; };
  }, [o?.id]);

  const onPickCustomer = (id: string) => {
    // Customer change invalidates project/site/customer-stock selections; the effect above
    // then reloads the new customer's projects/sites/stock.
    setProjects([]);
    setSites([]);
    setStockEntries([]);
    setLoadingProjects(Boolean(id));
    setCustomerId(id);
    setProjectId("");
    // The selected site belongs to the OLD customer, so it — and everything auto-filled from it — is
    // now invalid. Clear the whole site block so a stale address can never outlive its customer.
    setSiteId("");
    setSiteName("");
    setAddressLine1("");
    setAddressLine2("");
    setCity("");
    setCounty("");
    setPostcode("");
    setCountry("United Kingdom");
    setKitLines((rows) => rows.map((r) => (r.lineType === "customer_stock" ? { ...r, customerStockEntryId: "", customerStockItemKey: "", itemName: "", seCode: "", warehouseId: "", warehouseName: "", available: null } : r)));
    touch();
    clearError("customerId");
    clearError("projectId");
  };

  // Picking a saved site auto-fills the address block from that site's master record: name → site name,
  // and the full structured address (line 1/2, city, county, postcode, country) 1:1. Floor/suite/rack/
  // shelf + TRS area stay manual — they're job-specific micro-location, not site data. "None" (id === "")
  // clears the site-derived fields so the address can be typed by hand (country resets to the UK default).
  // Coordinates are deliberately left untouched: v1 jobs never geocode (job.validation.ts —
  // "latitude/longitude are never set from the client"), so lat/long stay null.
  const onPickSite = (id: string) => {
    const site = id ? sites.find((s) => s.id === id) ?? null : null;
    setSiteId(id);
    setSiteName(site?.name ?? "");
    setAddressLine1(site?.addressLine1 ?? "");
    setAddressLine2(site?.addressLine2 ?? "");
    setCity(site?.city ?? "");
    setCounty(site?.county ?? "");
    setPostcode(site?.postcode ?? "");
    setCountry(site?.country ?? "United Kingdom");
    // Either half of the destination rule satisfies it, so clear the error from here AND from the
    // address-line-1 field — otherwise a user who fixes it the other way still sees the message.
    clearError("siteId");
    touch();
  };

  // --- kit-line helpers ---
  const setLine = (key: string, patch: Partial<KitLine>) => setKitLines((rows) => rows.map((r) => (r._key === key ? { ...r, ...patch } : r)));
  const addLine = () => { setKitLines((rows) => [...rows, newKitLine()]); touch(); };
  const removeLine = (key: string) => { setKitLines((rows) => (rows.length === 1 ? rows : rows.filter((r) => r._key !== key))); touch(); };

  const onPickLineType = (key: string, lineType: JobLineType) => {
    // Reset the item-identity + warehouse fields when the line type changes.
    setLine(key, { lineType, customerStockEntryId: "", customerStockItemKey: "", irmItemId: "", rentalItemId: "", itemName: "", seCode: "", warehouseId: "", warehouseName: "", available: null, loadingAvail: false });
    touch();
    clearError("kitLines");
  };

  // Customer stock, collapsed from per-warehouse entries into pickable items. Each item carries the
  // warehouses that hold it (deduped, on-hand summed), each warehouse pointing back at a concrete
  // stock-entry id — so picking item → warehouse resolves to the exact entry the backend needs.
  // Entries with no warehouse yet are excluded: the backend rejects them (no pickup location).
  const stockItems = React.useMemo(() => {
    type Wh = { warehouseId: string; warehouseName: string; entryId: string; qty: number };
    const map = new Map<string, { key: string; itemName: string; sku: string | null; label: string; warehouses: Map<string, Wh> }>();
    for (const e of stockEntries) {
      if (!e.warehouseId) continue;
      const key = stockItemKey(e.sku, e.itemName);
      let g = map.get(key);
      if (!g) {
        g = { key, itemName: e.itemName, sku: e.sku, label: `${e.sku ? `${e.sku} — ` : ""}${e.itemName}`, warehouses: new Map() };
        map.set(key, g);
      }
      const existing = g.warehouses.get(e.warehouseId);
      if (existing) existing.qty += e.quantity; // same item, same warehouse, multiple entries → sum on-hand, keep first id
      else g.warehouses.set(e.warehouseId, { warehouseId: e.warehouseId, warehouseName: e.warehouseName, entryId: e.id, qty: e.quantity });
    }
    return map;
  }, [stockEntries]);

  const stockItemOptions = React.useMemo<Opt[]>(
    () => Array.from(stockItems.values()).map((g) => ({ value: g.key, label: g.label })),
    [stockItems],
  );

  // The same item from the same warehouse must appear on the kit list only ONCE — to take more, the
  // PM raises that line's qty (two lines would double-count the same stock). These guards reject a
  // pick that would duplicate another line's item+warehouse; submit-time validation backs them up.
  const irmDuplicate = (selfKey: string, irmItemId: string, warehouseId: string) =>
    kitLines.some((l) => l._key !== selfKey && l.lineType === "irm" && l.irmItemId === irmItemId && l.warehouseId === warehouseId);
  const rentalDuplicate = (selfKey: string, rentalItemId: string, warehouseId: string) =>
    kitLines.some((l) => l._key !== selfKey && l.lineType === "rental" && l.rentalItemId === rentalItemId && l.warehouseId === warehouseId);
  const customerDuplicate = (selfKey: string, entryId: string) =>
    kitLines.some((l) => l._key !== selfKey && l.lineType === "customer_stock" && l.customerStockEntryId === entryId);
  const DUPLICATE_MSG = "That item is already on the kit list for this warehouse — increase its quantity instead.";

  // Pick the item first. A single-warehouse item auto-binds its warehouse (and entry) so the common
  // case stays one click; multi-warehouse items wait for the warehouse pick to resolve the entry.
  const onPickStockItem = (key: string, itemKey: string) => {
    const g = stockItems.get(itemKey) ?? null;
    const only = g && g.warehouses.size === 1 ? Array.from(g.warehouses.values())[0] : null;
    // Single-warehouse item auto-binds its entry — block if that exact entry is already on another line.
    if (only && customerDuplicate(key, only.entryId)) { pushToast(DUPLICATE_MSG, "alert"); return; }
    setLine(key, {
      customerStockItemKey: itemKey,
      itemName: g?.itemName ?? "",
      seCode: g?.sku ?? "",
      customerStockEntryId: only ? only.entryId : "",
      warehouseId: only ? only.warehouseId : "",
      warehouseName: only ? only.warehouseName : "",
      available: only ? only.qty : null,
      loadingAvail: false,
    });
    touch();
    clearError("kitLines");
  };

  // Then the warehouse — resolves the concrete entry id the job line is saved against.
  const onPickStockWarehouse = (key: string, warehouseId: string) => {
    const line = kitLines.find((x) => x._key === key);
    const w = line ? stockItems.get(line.customerStockItemKey)?.warehouses.get(warehouseId) ?? null : null;
    if (w?.entryId && customerDuplicate(key, w.entryId)) { pushToast(DUPLICATE_MSG, "alert"); return; }
    setLine(key, {
      warehouseId,
      warehouseName: w?.warehouseName ?? "",
      customerStockEntryId: w?.entryId ?? "",
      available: w ? w.qty : null,
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

  // Warehouses that actually hold an IRM item — so the pickup dropdown only offers stocking sites
  // (an item can sit in several). Cached by item id, fetched once; on failure the entry is left
  // absent so the line falls back to the full warehouse list (never blocks the pick).
  const irmWhLoaded = React.useRef<Set<string>>(new Set());
  const loadIrmItemWarehouses = React.useCallback((itemId: string) => {
    if (!itemId || irmWhLoaded.current.has(itemId)) return;
    irmWhLoaded.current.add(itemId);
    setIrmItemWarehouses((prev) => (prev[itemId]?.status === "ready" ? prev : { ...prev, [itemId]: { status: "loading", options: prev[itemId]?.options ?? [] } }));
    listItemWarehouseStock(itemId).then(
      (rows) => {
        const options: Opt[] = rows
          .filter((r) => r.onHand > 0)
          .sort((a, b) => b.onHand - a.onHand)
          .map((r) => ({ value: r.warehouseId, label: `${r.warehouseName}${r.warehouseCode ? ` (${r.warehouseCode})` : ""} · ${r.onHand} in stock` }));
        setIrmItemWarehouses((prev) => ({ ...prev, [itemId]: { status: "ready", options } }));
      },
      () => {
        irmWhLoaded.current.delete(itemId); // allow a later retry
        setIrmItemWarehouses((prev) => ({ ...prev, [itemId]: { status: "error", options: [] } }));
      },
    );
  }, []);

  // Depots holding a hired item, cached by item id and fetched once — same shape and same failure
  // policy as loadIrmItemWarehouses above, so the two pickers behave identically.
  const rentalWhLoaded = React.useRef<Set<string>>(new Set());
  const loadRentalItemWarehouses = React.useCallback((itemId: string) => {
    if (!itemId || rentalWhLoaded.current.has(itemId)) return;
    rentalWhLoaded.current.add(itemId);
    setRentalItemWarehouses((prev) => (prev[itemId]?.status === "ready" ? prev : { ...prev, [itemId]: { status: "loading", options: prev[itemId]?.options ?? [] } }));
    getRentalItemAvailability(itemId).then(
      (rows) => {
        const options: Opt[] = rows.map((r) => ({
          value: r.warehouseId,
          // "on hire here", not "available" — the figure is GROSS, exactly like the IRM picker's
          // "N in stock" beside it. Other jobs' planned demand is netted off separately by
          // `freeStock` below, so a label promising "available" would name a number this form then
          // caps under, on the same dropdown where its neighbour is honest about being a raw count.
          label: `${r.warehouseName ?? "Warehouse"}${r.warehouseCode ? ` (${r.warehouseCode})` : ""} · ${r.available} on hire here`,
        }));
        setRentalItemWarehouses((prev) => ({ ...prev, [itemId]: { status: "ready", options } }));
        setRentalAvail((prev) => {
          const next = new Map(prev);
          for (const r of rows) next.set(`${itemId}|${r.warehouseId}`, r.available);
          return next;
        });
      },
      () => {
        rentalWhLoaded.current.delete(itemId); // allow a later retry
        setRentalItemWarehouses((prev) => ({ ...prev, [itemId]: { status: "error", options: [] } }));
      },
    );
  }, []);

  const onPickRentalItem = (key: string, item: RentalItem) => {
    // Fold the picked row into the loaded set — a search result is not in the first page, and the
    // line's label and the depot lookup below both read from it.
    setRentalItems((prev) => mergeById(prev, [item]));
    // New item ⇒ the old depot may not hold it; clear it so the user re-picks a valid collection point.
    setLine(key, { rentalItemId: item.id, itemName: rentalKitLabel(item), warehouseId: "", warehouseName: "", available: null, loadingAvail: false });
    loadRentalItemWarehouses(item.id);
    touch();
    clearError("kitLines");
  };

  const onPickIrmItem = (key: string, item: IrmItem) => {
    // Fold the picked row into the loaded set — a search result is not in the first page, and the
    // kit line's label, warehouse list and availability all read from it.
    setIrmItems((prev) => mergeIrmItems(prev, [item]));
    // New item ⇒ the old warehouse may not stock it; clear it so the user re-picks a valid site.
    setLine(key, { irmItemId: item.id, itemName: irmKitLabel(item), warehouseId: "", warehouseName: "", available: null, loadingAvail: false });
    loadIrmItemWarehouses(item.id);
    touch();
    clearError("kitLines");
  };

  // Edit mode: preload the stocking-warehouse list for IRM lines that already carry an item, so the
  // pickup dropdown narrows to real stocking sites on open (not only after the PM re-picks the item).
  // loadIrmItemWarehouses is ref-guarded against duplicate fetches, so re-runs stay cheap.
  React.useEffect(() => {
    for (const l of kitLines) if (l.lineType === "irm" && l.irmItemId) loadIrmItemWarehouses(l.irmItemId);
  }, [kitLines, loadIrmItemWarehouses]);

  // Same preload for hired lines, so an edit opens with the real collection points already narrowed.
  React.useEffect(() => {
    for (const l of kitLines) if (l.lineType === "rental" && l.rentalItemId) loadRentalItemWarehouses(l.rentalItemId);
  }, [kitLines, loadRentalItemWarehouses]);

  const onPickLineWarehouse = (key: string, warehouseId: string) => {
    const w = warehouses.find((x) => x.id === warehouseId) ?? null;
    const line = kitLines.find((x) => x._key === key);
    if (line?.irmItemId && irmDuplicate(key, line.irmItemId, warehouseId)) { pushToast(DUPLICATE_MSG, "alert"); return; }
    if (line?.rentalItemId && rentalDuplicate(key, line.rentalItemId, warehouseId)) { pushToast(DUPLICATE_MSG, "alert"); return; }
    // Bare name to match the server snapshot + detail tables (the code lives in the picker label).
    setLine(key, { warehouseId, warehouseName: w ? w.name : "" });
    // A hire's free count came back with the depot list, so there is nothing further to fetch —
    // unlike IRM, whose availability is a second per-pair lookup.
    if (line?.lineType === "rental") {
      setLine(key, { available: rentalAvail.get(`${line.rentalItemId}|${warehouseId}`) ?? null, loadingAvail: false });
    } else {
      loadAvailability(key, line?.irmItemId ?? "", warehouseId);
    }
    touch();
    clearError("kitLines");
  };

  // --- attachments helpers ---
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [uploadingDoc, setUploadingDoc] = React.useState(false);

  const setAttachment = (i: number, v: string) => {
    setAttachments((rows) => rows.map((r, idx) => (idx === i ? v : r)));
    touch();
    clearError("attachments");
  };
  const addAttachment = () => {
    setAttachments((rows) => [...rows, ""]);
    touch();
  };
  const removeAttachment = (i: number) => {
    setAttachments((rows) => (rows.length <= 1 ? [""] : rows.filter((_, idx) => idx !== i)));
    touch();
    clearError("attachments");
  };

  // Takes the File itself, so the input's onChange and a DROP call one function. The old signature
  // took the change event, which is why a drop could not have reused it without a second copy of
  // every rule below.
  // Blank rows are the form's own placeholders, never attachments — counted the same way in every
  // place that asks "how many are attached?".
  const activeAttachmentCount = attachments.filter((a) => a.trim().length > 0).length;

  const handleFile = async (rawFile: File) => {
    // The cap is checked HERE rather than only on the buttons, so a DROP obeys it too. The buttons
    // still disable at the ceiling — that is the better affordance when there is one to give — but
    // a drop target has no disabled state the user can see mid-drag, so it needs the message.
    if (!canAddJobAttachment(activeAttachmentCount)) {
      pushToast(`You can attach at most ${JOB_ATTACHMENT_MAX} files.`, "alert");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    if (resolveFileType(rawFile.name, ATTACH_ALLOWED) == null) {
      pushToast(`Unsupported file type. Use ${BUSINESS_DOC_LABEL}.`, "alert");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    // Downscale before measuring. This picker advertises site photos, and a phone photo clears
    // 10 MB easily — measuring the original would refuse a file that stores as a few hundred KB.
    // Drawings and quotes are PDFs, which shrinkImage returns untouched.
    const file = await shrinkImage(rawFile);
    // Re-derived, because a PNG re-encoded as JPEG arrives here renamed.
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const maxBytes = 10 * 1024 * 1024; // 10 MB per file limit
    if (file.size > maxBytes) {
      pushToast(`"${file.name}" exceeds the 10 MB limit.`, "alert");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setUploadingDoc(true);
    try {
      // Straight to Cloudinary. `EXT_MEDIA_TYPE` stands in when the browser reports no type at all (a .docx on a machine
      // with no Office install) AND when it reports a misleading one — Windows hands back
      // `application/vnd.ms-excel` for a .csv when Excel is the registered handler, which would
      // declare a text file as a binary workbook and fail its OLE2 magic-byte check at finalize.
      const declared = EXT_MEDIA_TYPE[ext];
      const url = await uploadDirectForUrl({
        purpose: "job_attachment",
        file: declared && file.type !== declared ? new File([file], file.name, { type: declared }) : file,
      });
      setAttachments((rows) => {
        const active = rows.filter((r) => r.trim().length > 0);
        return [...active, url];
      });
      touch();
      clearError("attachments");
      pushToast(`"${file.name}" uploaded successfully.`, "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Document upload failed.";
      pushToast(msg, "alert");
    } finally {
      setUploadingDoc(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // One at a time, matching the input — the job form appends each upload's URL to a list, and two
  // in flight would both read the same `attachments` snapshot and drop one of the two.
  const { dragging, dropProps } = useFileDrop((files) => void handleFile(files[0]), uploadingDoc);

  // Demand from OTHER active jobs for a line's item+warehouse, and the stock TRULY free to plan
  // (on-hand − that demand). null free = availability not loaded yet (no cap can be applied).
  const demandKey = (l: KitLine): string | null =>
    l.lineType === "irm" ? (l.irmItemId && l.warehouseId ? `irm|${l.irmItemId}|${l.warehouseId}` : null)
    : l.lineType === "rental" ? (l.rentalItemId && l.warehouseId ? `rental|${l.rentalItemId}|${l.warehouseId}` : null)
    : l.lineType === "customer_stock" ? (l.customerStockEntryId ? `cse|${l.customerStockEntryId}` : null)
    : null;
  const lineDemand = (l: KitLine): number => { const k = demandKey(l); return k ? demand.get(k) ?? 0 : 0; };
  const freeStock = (l: KitLine): number | null => (l.available == null ? null : Math.max(0, l.available - lineDemand(l)));
  // Max qty plannable on a line: free stock for a normal line; for an already-issued (locked) line the
  // already-out qty plus what's still free to add. null = availability not loaded (no cap).
  const lineMaxQty = (l: KitLine): number | null => {
    const f = freeStock(l);
    if (f == null) return null;
    return l.issued > 0 ? Math.max(l.lockedQty, l.issued + f) : f;
  };

  const lineIsValid = (l: KitLine): boolean => {
    if (num(l.qty) < 1) return false;
    if (l.lineType === "misc") return Boolean(l.itemName.trim());
    if (l.lineType === "customer_stock") return Boolean(l.customerStockEntryId);
    // Hired kit is collected from a depot like IRM stock, so it needs the item AND the pickup point.
    if (l.lineType === "rental") return Boolean(l.rentalItemId && l.warehouseId);
    return Boolean(l.irmItemId && l.warehouseId); // irm needs the item AND a pickup warehouse
  };

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Job name is required.";
    if (!customerId) e.customerId = "Select a customer.";
    if (!projectId) e.projectId = "Select a project.";
    if (!assignedEngineerId) e.assignedEngineerId = "Assign an engineer.";
    // Required in BOTH modes, exactly like the destination rule below. A job here is always dispatched
    // work — there is no draft state — and one with no due date is absent from every overdue and
    // due-today view in the app, so it can only be found by someone already reading the full list.
    if (!completionDate) e.completionDate = "Set the completion date — a job must say when it is due.";
    // A job dispatches an engineer somewhere, so it must name a destination — by reference (a saved
    // site) or by text (an address). Picking a site copies its address into these same fields, so
    // both paths converge here. Either/or rather than "address required": a customer site's own
    // address fields are optional, so a site can be saved with just a name, and demanding an address
    // would reject someone who correctly picked such a site. Mirrors createJobSchema's superRefine.
    // Applies to BOTH modes: a job can't be left without a destination any more than it can be born
    // without one. Create is checked by createJobSchema's superRefine, update by job.service (only
    // the service can see the existing row a PATCH merges into) — so this stays in step with the API
    // either way.
    if (!siteId && !addressLine1.trim()) {
      e.siteId = "Pick a site, or enter an address below for where the work happens.";
    }
    const active = kitLines.filter(lineIsValid);
    if (active.length === 0) {
      e.kitLines = "Add at least one kit line (a quantity, and an item or a name).";
    } else {
      // Can't plan more than allowed (free stock — and, for an issued line, what's already out + free).
      const over = active.find((l) => { const m = lineMaxQty(l); return l.lineType !== "misc" && m != null && num(l.qty) > m; });
      if (over) {
        e.kitLines = `"${over.itemName || over.seCode || "An item"}" — only ${lineMaxQty(over) ?? 0} can be planned here, but ${num(over.qty)} requested.`;
      } else {
        // No item+warehouse listed twice — one line per item/warehouse, raise its qty to take more.
        const seen = new Set<string>();
        for (const l of active) {
          if (l.lineType === "misc") continue;
          const k = l.lineType === "irm"
            ? `irm:${l.irmItemId}:${l.warehouseId}`
            : l.lineType === "rental"
              ? `rental:${l.rentalItemId}:${l.warehouseId}`
              : `cse:${l.customerStockEntryId}`;
          if (seen.has(k)) { e.kitLines = `"${l.itemName || l.seCode || "An item"}" is listed twice for the same warehouse — combine it into one line and raise the quantity.`; break; }
          seen.add(k);
        }
      }
    }
    // Mirrors createJobSchema's `attachments` rule (job.validation.ts → utils/http-url.ts): http(s)
    // only, because these render as links and `javascript:` / `data:` are valid URLs that execute
    // when clicked. The server rejects them either way — what only this side can do is say WHICH box
    // is wrong. Without it a bad link on row 3 of 5 came back as a bare toast naming no field.
    const badLink = attachments.map((a) => a.trim()).filter(Boolean).find((a) => !isHttpUrl(a));
    if (badLink) {
      e.attachments = `"${badLink}" isn't a link. Attachments must start with http:// or https://.`;
    }
    return e;
  };

  const buildPayload = (): jobService.JobPayload => {
    // On edit an emptied box must send "" (= clear it); on create a blank stays omitted. See
    // lib/formPayload.ts — `|| undefined` here meant a cleared field never reached the server.
    const opt = optionalFor(mode === "edit");
    return {
      name: name.trim(),
      customerRef: opt(customerRef),
      schemeNo: opt(schemeNo),
      jobType: jobType || undefined,
      technology: opt(technology),
      priority: priority || undefined,
      customerId,
      projectId,
      siteId: opt(siteId),
      siteName: opt(siteName),
      trsArea: opt(trsArea),
      addressLine1: opt(addressLine1),
      addressLine2: opt(addressLine2),
      city: opt(city),
      county: opt(county),
      postcode: opt(postcode),
      country: opt(country),
      floor: opt(floor),
      suite: opt(suite),
      rack: opt(rack),
      shelf: opt(shelf),
      // Sent plainly, not through `opt`: this is a REQUIRED field now, so it never needs the
      // clear-on-edit "" that optionalFor exists to produce — and validate() has already refused a
      // blank in both modes before we reach here.
      completionDate: completionDate.trim(),
      assignedEngineerId,
      installerType: installerType || undefined,
      supplierId: opt(supplierId),
      plannerName: opt(plannerName),
      plannerPhone: opt(plannerPhone),
      notes: opt(notes),
      attachments: attachments.map((a) => a.trim()).filter(Boolean),
      kitLines: kitLines.filter(lineIsValid).map((l) => ({
        lineType: l.lineType,
        itemName: l.lineType === "misc" ? l.itemName.trim() : (l.itemName.trim() || l.seCode.trim() || "Item"),
        seCode: l.seCode.trim() || undefined,
        description: l.description.trim() || undefined,
        customerStockEntryId: l.lineType === "customer_stock" ? l.customerStockEntryId : undefined,
        irmItemId: l.lineType === "irm" ? l.irmItemId : undefined,
        rentalItemId: l.lineType === "rental" ? l.rentalItemId : undefined,
        // customer_stock warehouse is derived server-side from the entry; irm and rental send the
        // chosen collection point.
        warehouseId: l.lineType === "irm" || l.lineType === "rental" ? l.warehouseId || undefined : undefined,
        qty: num(l.qty),
        // Kit lines stay `|| undefined`: a line is REPLACED wholesale on save, never patched, so an
        // omitted key already means "this line has no note" rather than "leave the old note alone".
        notes: l.notes.trim() || undefined,
      })),
    };
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

  const goBack = () =>
    guard.attemptLeave(() => {
      if (window.history.length > 1) router.back();
      else router.push(JOBS_LIST);
    });

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
                <Select value={customerId} onChange={onPickCustomer} options={withHistoricalOption(customers, customerId, job?.customerName)} placeholder="— Select customer —" ariaLabel="Customer" invalid={Boolean(errors.customerId)} />
                <FieldError message={errors.customerId} />
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <label className={`${labelCls} mb-0`}>Project<RequiredMark /></label>
                  {customerId && canCreateProject && (
                    <button type="button" onClick={() => setShowProjectModal(true)} className="flex items-center gap-1 text-[11px] font-bold text-[var(--accent)] transition-all hover:opacity-80">
                      <Plus className="h-3 w-3" /> New project
                    </button>
                  )}
                </div>
                <Select value={projectId} onChange={(v) => { setProjectId(v); touch(); clearError("projectId"); }} options={projects.map((p) => ({ value: p.id, label: p.code ? `${p.code} — ${p.name}` : p.name }))} placeholder={customerId ? (loadingProjects ? "Loading…" : "— Select project —") : "Pick a customer first"} disabled={!customerId || loadingProjects} ariaLabel="Project" invalid={Boolean(errors.projectId)} />
                <FieldError message={errors.projectId} />
                {customerId && !loadingProjects && projects.length === 0 && (
                  <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                    This customer has no projects yet.{canCreateProject && <> <button type="button" onClick={() => setShowProjectModal(true)} className="font-bold text-[var(--accent)] hover:opacity-80">Add one</button>.</>}
                  </p>
                )}
              </div>
            </div>
            {/* Inline "Add project" — creates a project for the selected customer and selects it,
                same modal the Customer module uses (PRJ-#### auto-allocated server-side). */}
            {showProjectModal && customerId && (
              <ProjectModal
                customerId={customerId}
                project={null}
                onClose={() => setShowProjectModal(false)}
                onSaved={(p) => {
                  setProjects((prev) => [...prev, p]);
                  setProjectId(p.id);
                  touch();
                  clearError("projectId");
                  setShowProjectModal(false);
                }}
              />
            )}
          </Step>

          {/* Step 3 — Site / Location */}
          {/* The step carries the RequiredMark, not the Site field: what's mandatory is a DESTINATION
              — a saved site or a typed address — and neither field alone is the required one. */}
          <Step n={3} title={<>Site &amp; location<RequiredMark /></>} description="Where the work happens. Pick a saved site, or enter the address manually — a job needs one or the other.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>Site</label>
                <Select value={siteId} onChange={onPickSite} options={[{ value: "", label: "— None / enter manually —" }, ...sites.map((s) => ({ value: s.id, label: s.code ? `${s.code} — ${s.name}` : s.name }))]} placeholder={customerId ? "— Select site —" : "Pick a customer first"} disabled={!customerId} invalid={Boolean(errors.siteId)} ariaLabel="Site" />
                <FieldError message={errors.siteId} />
                {!errors.siteId && (
                  <p className="mt-1.5 text-[11px] text-[var(--faint)]">Choose a saved customer site, or leave as “None” and fill in the address below.</p>
                )}
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
                <label className={labelCls}>Address line 1</label>
                <input className={inputCls} value={addressLine1} onChange={(e) => { setAddressLine1(e.target.value); clearError("siteId"); touch(); }} maxLength={300} placeholder="Street address" />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Address line 2</label>
                <input className={inputCls} value={addressLine2} onChange={(e) => { setAddressLine2(e.target.value); touch(); }} maxLength={300} placeholder="Optional" />
              </div>
              <div>
                <label className={labelCls}>City / town</label>
                <input className={inputCls} value={city} onChange={(e) => { setCity(e.target.value); touch(); }} maxLength={120} placeholder="e.g. Leeds" />
              </div>
              <div>
                <label className={labelCls}>County</label>
                <input className={inputCls} value={county} onChange={(e) => { setCounty(e.target.value); touch(); }} maxLength={120} placeholder="Optional" />
              </div>
              <PostcodeField
                value={postcode}
                onChange={(v) => { setPostcode(v); touch(); }}
                setCity={(v) => { setCity(v); touch(); }}
                setCounty={(v) => { setCounty(v); touch(); }}
                setCountry={(v) => { setCountry(v); touch(); }}
                required={false}
              />
              <div>
                <label className={labelCls}>Country</label>
                <input className={inputCls} value={country} onChange={(e) => { setCountry(e.target.value); touch(); }} maxLength={120} placeholder="United Kingdom" list="job-country-options" />
                <datalist id="job-country-options">
                  <option value="United Kingdom" />
                </datalist>
              </div>
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
                <label className={labelCls}>Completion date<RequiredMark /></label>
                <input
                  type="date"
                  className={inputCls}
                  value={completionDate}
                  aria-invalid={Boolean(errors.completionDate)}
                  onChange={(e) => { setCompletionDate(e.target.value); touch(); clearError("completionDate"); }}
                />
                <FieldError message={errors.completionDate} />
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
                <Select value={supplierId} onChange={(v) => { setSupplierId(v); touch(); }} options={withHistoricalOption([{ value: "", label: "— None —" }, ...suppliers], supplierId, o?.supplierName)} placeholder="— None —" ariaLabel="Supplier" />
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
          <Step n={5} title={<>Kit list<RequiredMark /></>} description="What the engineer takes — customer stock, IRM stock, or a free-text item. At least one line is required.">
            <div className="space-y-3">
              {kitLines.map((l) => {
                // Stock truly free to plan = on-hand − what other active jobs already plan for it.
                const dQty = lineDemand(l);
                const free = freeStock(l);
                // Already-issued line ⇒ LOCKED: item/warehouse fixed, can't be removed, qty can only
                // INCREASE (min = planned-at-edit) and only up to what's still free to issue on top of
                // what's already out (issued + free). Matches the backend edit-lock guard.
                const locked = l.issued > 0;
                const minQty = locked ? l.lockedQty : 1;
                const maxQty = lineMaxQty(l) ?? undefined;
                // Warehouses that hold the picked customer-stock item — the only valid pickup spots.
                const stockWhOptions = l.lineType === "customer_stock" && l.customerStockItemKey
                  ? Array.from(stockItems.get(l.customerStockItemKey)?.warehouses.values() ?? []).map((w) => ({ value: w.warehouseId, label: w.warehouseName }))
                  : [];
                // IRM pickup options. "ready" ⇒ exactly the warehouses that stock the item (an empty
                // list means stocked nowhere — handled separately below, NOT widened to all). Only a
                // failed/absent lookup (loading or no inventory permission) falls back to the full
                // list. The selected warehouse is always kept present so a saved pick is never lost.
                const irmLookup = l.lineType === "irm" && l.irmItemId ? irmItemWarehouses[l.irmItemId] : undefined;
                const allWhOptions = warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` }));
                // Stocked nowhere — block the pick. (Skip when the line already carries a warehouse,
                // e.g. an edit-mode job whose item has since gone to zero: keep the existing pick.)
                const irmNotStocked = irmLookup?.status === "ready" && irmLookup.options.length === 0 && !l.warehouseId;
                // Fresh pick still resolving — show a checking state rather than briefly flashing the
                // full warehouse list (an existing selection keeps the dropdown so it stays visible).
                const irmWhLoading = irmLookup?.status === "loading" && !l.warehouseId;
                let irmWhOptions = irmLookup?.status === "ready" ? irmLookup.options : allWhOptions;
                if (l.warehouseId && !irmWhOptions.some((o) => o.value === l.warehouseId)) {
                  const sel = allWhOptions.find((o) => o.value === l.warehouseId);
                  if (sel) irmWhOptions = [...irmWhOptions, sel];
                }
                // The rental twin of the three values above. "Ready and empty" means the item is on
                // no live hire with a spare unit — a real answer, and NOT the same as the lookup
                // failing, which falls back to the full depot list so the pick is never hard-blocked.
                const rentalLookup = l.lineType === "rental" && l.rentalItemId ? rentalItemWarehouses[l.rentalItemId] : undefined;
                const rentalNotHired = rentalLookup?.status === "ready" && rentalLookup.options.length === 0 && !l.warehouseId;
                const rentalWhLoading = rentalLookup?.status === "loading" && !l.warehouseId;
                let rentalWhOptions = rentalLookup?.status === "ready" ? rentalLookup.options : allWhOptions;
                if (l.warehouseId && !rentalWhOptions.some((opt) => opt.value === l.warehouseId)) {
                  const sel = allWhOptions.find((opt) => opt.value === l.warehouseId);
                  if (sel) rentalWhOptions = [...rentalWhOptions, sel];
                }
                return (
                <div key={l._key} className="@container rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-3">
                  <div className="grid grid-cols-1 gap-3 @sm:grid-cols-12">
                    <div className="min-w-0 @sm:col-span-6 @3xl:col-span-2">
                      <label className={labelCls}>Source</label>
                      <Select value={l.lineType} onChange={(v) => onPickLineType(l._key, v as JobLineType)} options={JOB_LINE_TYPES.map((t) => ({ value: t, label: JOB_LINE_TYPE_LABELS[t] }))} disabled={locked} ariaLabel="Line source" />
                    </div>
                    <div className="min-w-0 @sm:col-span-6 @3xl:col-span-4">
                      <label className={labelCls}>Item<RequiredMark /></label>
                      {l.lineType === "customer_stock" ? (
                        !customerId ? (
                          <p className="flex h-[42px] items-center truncate rounded-xl border border-dashed border-[var(--border)] px-3 text-[11px] text-[var(--faint)]">Pick a customer in step 2 first.</p>
                        ) : (
                          <Select value={l.customerStockItemKey} onChange={(v) => onPickStockItem(l._key, v)} options={stockItemOptions} placeholder="— Select customer stock —" disabled={locked} ariaLabel="Customer stock item" />
                        )
                      ) : l.lineType === "irm" ? (
                        <IrmItemPicker
                          value={l.irmItemId}
                          selectedItem={irmItems.find((i) => i.id === l.irmItemId) ?? null}
                          seed={irmItems}
                          onSelect={(item) => onPickIrmItem(l._key, item)}
                          canCreate={false}
                          disabled={locked}
                          // So a SAVED line still being resolved reads as loading rather than as an
                          // empty picker on a line that is in fact set.
                          loading={refLoading || resolvingIrmItems}
                          ariaLabel="IRM item"
                        />
                      ) : l.lineType === "rental" ? (
                        <RentalItemPicker
                          value={l.rentalItemId}
                          selectedItem={rentalItems.find((i) => i.id === l.rentalItemId) ?? null}
                          seed={rentalItems}
                          onSelect={(item) => onPickRentalItem(l._key, item)}
                          // Job planning picks from the hire catalogue; it has never created entries
                          // in it, and this change deliberately does not start.
                          canCreate={false}
                          disabled={locked}
                          loading={refLoading || resolvingRentalItems}
                          ariaLabel="Rental item"
                        />
                      ) : (
                        <input className={inputCls} value={l.itemName} onChange={(e) => { setLine(l._key, { itemName: e.target.value }); touch(); clearError("kitLines"); }} maxLength={200} placeholder="Item name" disabled={locked} />
                      )}
                    </div>
                    <div className="min-w-0 @sm:col-span-8 @3xl:col-span-3">
                      <label className={labelCls}>Warehouse{l.lineType === "irm" || l.lineType === "rental" ? <RequiredMark /> : null}</label>
                      {l.lineType === "irm" ? (
                        !l.irmItemId ? (
                          <div className="flex h-[42px] items-center rounded-xl border border-dashed border-[var(--border)] px-3 text-[11px] text-[var(--faint)]">Pick an item first</div>
                        ) : irmWhLoading ? (
                          <div className="flex h-[42px] items-center rounded-xl border border-dashed border-[var(--border)] px-3 text-[11px] text-[var(--faint)]">Checking stock…</div>
                        ) : irmNotStocked ? (
                          <div className="flex h-[42px] items-center rounded-xl border border-dashed border-[var(--neg)]/40 px-3 text-[11px] text-[var(--neg)]" title="This item has no on-hand stock in any warehouse.">Not stocked anywhere</div>
                        ) : (
                          <Select value={l.warehouseId} onChange={(v) => onPickLineWarehouse(l._key, v)} options={irmWhOptions} placeholder="— Pick warehouse —" disabled={locked} ariaLabel="Pickup warehouse" />
                        )
                      ) : l.lineType === "rental" ? (
                        !l.rentalItemId ? (
                          <div className="flex h-[42px] items-center rounded-xl border border-dashed border-[var(--border)] px-3 text-[11px] text-[var(--faint)]">Pick an item first</div>
                        ) : rentalWhLoading ? (
                          <div className="flex h-[42px] items-center rounded-xl border border-dashed border-[var(--border)] px-3 text-[11px] text-[var(--faint)]">Checking hires…</div>
                        ) : rentalNotHired ? (
                          <div className="flex h-[42px] items-center rounded-xl border border-dashed border-[var(--neg)]/40 px-3 text-[11px] text-[var(--neg)]" title="No live hire of this rental item has a spare unit at any depot. Raise a purchase request to hire one.">None on hire</div>
                        ) : (
                          <Select value={l.warehouseId} onChange={(v) => onPickLineWarehouse(l._key, v)} options={rentalWhOptions} placeholder="— Pick warehouse —" disabled={locked} ariaLabel="Pickup warehouse" />
                        )
                      ) : l.lineType === "customer_stock" ? (
                        !l.customerStockItemKey ? (
                          <div className="flex h-[42px] items-center rounded-xl border border-dashed border-[var(--border)] px-3 text-[11px] text-[var(--faint)]">Pick an item first</div>
                        ) : (
                          <Select value={l.warehouseId} onChange={(v) => onPickStockWarehouse(l._key, v)} options={stockWhOptions} placeholder="— Pick warehouse —" disabled={locked} ariaLabel="Pickup warehouse" />
                        )
                      ) : (
                        <div className="flex h-[42px] items-center rounded-xl border border-dashed border-[var(--border)] px-3 text-[11px] text-[var(--faint)]">Not applicable</div>
                      )}
                    </div>
                    <div className="min-w-0 @sm:col-span-4 @3xl:col-span-3">
                      <label className={labelCls}>Qty<RequiredMark /></label>
                      <NumberInput className={inputCls} min={minQty} step={1} value={l.qty}
                        onChange={(e) => { setLine(l._key, { qty: e.target.value }); touch(); clearError("kitLines"); }}
                        onBlur={(e) => {
                          // Clamp ONLY on blur so typing stays free (no jumping to the max mid-keystroke).
                          // Range: locked lines can't drop below planned/issued; nothing exceeds free-to-issue.
                          const raw = e.target.value;
                          let v = raw;
                          if (raw === "") v = String(minQty);
                          else {
                            const n = Number(raw);
                            if (maxQty != null && n > maxQty) v = String(maxQty);
                            else if (n < minQty) v = String(minQty);
                          }
                          if (v !== raw) setLine(l._key, { qty: v });
                        }} placeholder="1" />
                      {/* Locked (issued) lines show the lock note; others show free-to-plan stock. */}
                      {locked ? (
                        <p className={`mt-1 text-[11px] ${maxQty != null && num(l.qty) > maxQty ? "font-semibold text-[var(--neg)]" : "text-[var(--muted)]"}`}>Issued {l.issued} — can only increase{free != null && free > 0 ? ` (${free} more available)` : ""}.</p>
                      ) : l.lineType !== "misc" && (
                        l.loadingAvail ? (
                          <p className="mt-1 text-[11px] text-[var(--faint)]">Checking stock…</p>
                        ) : free != null ? (
                          <p className={`mt-1 text-[11px] ${free < num(l.qty) ? "font-semibold text-[var(--neg)]" : "text-[var(--muted)]"}`}>
                            {free} free{dQty > 0 ? <span className="text-[var(--faint)]"> ({l.available} − {dQty} planned)</span> : ""}
                          </p>
                        ) : null
                      )}
                    </div>
                    <div className="flex items-stretch gap-2 @sm:col-span-12">
                      <input className={`${inputCls} min-w-0 flex-1`} value={l.notes} onChange={(e) => { setLine(l._key, { notes: e.target.value }); touch(); }} maxLength={500} placeholder="Line note (optional)" />
                      <button type="button" onClick={() => removeLine(l._key)} disabled={kitLines.length === 1 || locked} title={locked ? "Issued items can't be removed" : undefined} className="flex w-11 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--neg)] disabled:opacity-40" aria-label="Remove line"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                  {l.lineType === "customer_stock" && l.seCode && (
                    <div className="mt-1.5 text-[11px] text-[var(--faint)]">SE code {l.seCode}.</div>
                  )}
                </div>
                );
              })}
              <button type="button" onClick={addLine} className="flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-1.5 text-xs font-bold text-[var(--accent)] hover:bg-[var(--surface-2)]"><Plus className="h-3.5 w-3.5" /> Add line</button>
            </div>
            <FieldError message={errors.kitLines} />
          </Step>

          {/* Step 6 — Attachments, notes & review */}
          <Step n={6} title="Attachments, notes & review" description="Upload documents, reference links, notes, and a final check.">
            <div className="space-y-4">
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className={`${labelCls} mb-0`}>Attachments & Links</label>
                  <span className="text-[11px] font-semibold text-[var(--faint)]">
                    {attachments.filter((a) => a.trim()).length} attached
                  </span>
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ATTACH_ACCEPT}
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
                />

                {/* The drop target is the ROW LIST plus the buttons below it — the region that
                    already means "the attachments on this job". It adds no height of its own. */}
                <div {...dropProps} className={`space-y-2 p-1 ${dropRing(dragging)}`}>
                  {attachments.map((a, i) => {
                    const meta = parseJobAttachment(a);
                    // Only files WE uploaded render as a fixed row. A pasted link — whatever its
                    // extension — stays an editable text field, because correcting a mistyped URL
                    // must not mean deleting the row and re-entering it.
                    // Written as an aliased condition (`meta !== null && …`) so TypeScript narrows
                    // `meta` inside the branch below — `meta?.isUploaded` would not.
                    const isUploadedDoc = meta !== null && meta.isUploaded;

                    return (
                      <div key={i} className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-2">
                        {isUploadedDoc ? (
                          <div className="flex min-w-0 flex-1 items-center gap-2.5 px-1">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[var(--accent)]">
                              {meta.isImg ? (
                                <ImageIcon className="h-4 w-4" />
                              ) : meta.isPdf || meta.isDoc ? (
                                <FileText className="h-4 w-4" />
                              ) : (
                                <LinkIcon className="h-4 w-4" />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-bold text-[var(--ink)]" title={meta.name}>
                                {meta.name}
                              </p>
                              <a
                                href={meta.rawUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--accent)] hover:underline"
                              >
                                View attachment <ExternalLink className="h-3 w-3" />
                              </a>
                            </div>
                          </div>
                        ) : (
                          <input
                            className={`${inputCls} min-w-0 flex-1`}
                            value={meta?.rawUrl ?? a}
                            onChange={(e) => {
                              const val = e.target.value;
                              const isInt = meta?.isInternal;
                              setAttachment(i, isInt && val.trim() ? `${val}#internal` : val);
                            }}
                            maxLength={500}
                            placeholder="https://…"
                          />
                        )}

                        {a.trim() && (
                          <div className="inline-flex shrink-0 items-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
                            <button
                              type="button"
                              onClick={() => {
                                if (meta?.isInternal) {
                                  const next = a.replace(/#internal$/i, "");
                                  setAttachment(i, next);
                                }
                              }}
                              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-bold transition-all ${
                                !meta?.isInternal
                                  ? "bg-emerald-600 text-white shadow-xs"
                                  : "text-[var(--muted)] hover:text-[var(--ink)]"
                              }`}
                              title="Customer visible — shown on Customer Portal"
                            >
                              <Globe className="h-3.5 w-3.5" /> Customer
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (!meta?.isInternal) {
                                  const next = `${a}#internal`;
                                  setAttachment(i, next);
                                }
                              }}
                              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-bold transition-all ${
                                meta?.isInternal
                                  ? "bg-amber-600 text-white shadow-xs"
                                  : "text-[var(--muted)] hover:text-[var(--ink)]"
                              }`}
                              title="Internal document — Office & Engineers only"
                            >
                              <Lock className="h-3.5 w-3.5" /> Internal
                            </button>
                          </div>
                        )}

                        <button
                          type="button"
                          onClick={() => removeAttachment(i)}
                          disabled={attachments.length === 1 && !attachments[0]}
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--neg)] disabled:opacity-40"
                          aria-label="Remove attachment"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    );
                  })}

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingDoc || !canAddJobAttachment(activeAttachmentCount)}
                      className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60"
                    >
                      {uploadingDoc ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      {uploadingDoc ? "Uploading…" : "Upload document"}
                    </button>

                    <button
                      type="button"
                      onClick={addAttachment}
                      disabled={uploadingDoc || !canAddJobAttachment(activeAttachmentCount)}
                      className="flex items-center gap-1.5 rounded-xl border border-dashed border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--accent)] hover:bg-[var(--surface-2)] disabled:opacity-60"
                    >
                      <Plus className="h-3.5 w-3.5" /> Add link
                    </button>
                  </div>
                </div>

                <FieldError message={errors.attachments} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                  Upload documents, drawings, site photos, or quotes — drag them onto the list or use Upload ({BUSINESS_DOC_LABEL}, max 10 MB) — or paste external links.
                </p>
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
              <SummaryRow label="Customer" valueClassName="font-semibold">{customerName ?? "—"}</SummaryRow>
              <SummaryRow label="Project" valueClassName="font-semibold">{projectName ?? "—"}</SummaryRow>
              <SummaryRow label="Engineer" valueClassName="font-semibold">{engineerName ?? "—"}</SummaryRow>
              <SummaryRow label="Priority" valueClassName="font-semibold">{JOB_PRIORITY_LABELS[priority as keyof typeof JOB_PRIORITY_LABELS] ?? priority}</SummaryRow>
              <SummaryRow label="Completion" valueClassName="font-semibold">{completionDate || "—"}</SummaryRow>
              <SummaryRow label="Kit lines" valueClassName="font-semibold">{validLines.length}</SummaryRow>
              <SummaryRow label="Total units" valueClassName="font-extrabold">{totalUnits}</SummaryRow>
              <p className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 text-[11px] text-[var(--muted)]">{mode === "create" ? "On save the job is assigned to the engineer, who is notified in real time and accepts it from their portal. The job number is allocated on save." : "Saving updates the job header and replaces the kit list."}</p>
            </div>
          </FormAsideCard>
        </aside>
      </div>
    </form>
  );
}
