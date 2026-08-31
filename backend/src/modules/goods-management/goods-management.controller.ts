import * as service from "./goods-management.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import type { CloseReconcileInput, PostMovementInput, ReportDamageInput, RestoreDamagedInput, ScanLookupInput } from "./goods-management.validation.js";
import { badRequest } from "../../utils/http-error.js";

export const scanLookup = asyncHandler(async (req, res) => {
  res.json({ match: await service.scanLookup(req.body as ScanLookupInput, actorFrom(req)) });
});

export const postIssue = asyncHandler(async (req, res) => {
  res.status(201).json({ movement: await service.postIssue(param(req, "jobId"), req.body as PostMovementInput, actorFrom(req)) });
});

export const postReturn = asyncHandler(async (req, res) => {
  res.status(201).json({ movement: await service.postReturn(param(req, "jobId"), req.body as PostMovementInput, actorFrom(req)) });
});

export const listQueue = asyncHandler(async (req, res) => {
  const warehouseId = (req.query["warehouseId"] as string | undefined)?.trim();
  if (!warehouseId) throw badRequest("warehouseId is required.");
  res.json(
    await service.listQueue(
      {
        warehouseId,
        status: (req.query["status"] as string | undefined)?.trim() || undefined,
        search: (req.query["search"] as string | undefined) ?? undefined,
        // Last-activity window. Unparseable values are dropped by the service (no filter) rather than
        // rejected — these arrive from a URL the user can edit, and a typo shouldn't 400 the whole tab.
        activityFrom: queryStr(req.query["activityFrom"])?.trim() || undefined,
        activityTo: queryStr(req.query["activityTo"])?.trim() || undefined,
        // Due window on the job's completion date — validated in the service against QUEUE_DUE_FILTERS.
        due: queryStr(req.query["due"])?.trim() || undefined,
        // The EXACT due range, alongside the bucket above — both narrow completionDate.
        dueFrom: queryStr(req.query["dueFrom"])?.trim() || undefined,
        dueTo: queryStr(req.query["dueTo"])?.trim() || undefined,
        engineerId: queryStr(req.query["engineerId"])?.trim() || undefined,
        customerId: queryStr(req.query["customerId"])?.trim() || undefined,
        siteId: queryStr(req.query["siteId"])?.trim() || undefined,
        sort: queryStr(req.query["sort"])?.trim() || undefined,
        page: queryInt(req.query["page"]),
        pageSize: queryInt(req.query["pageSize"]),
      },
      actorFrom(req),
    ),
  );
});

export const getJobGoods = asyncHandler(async (req, res) => {
  res.json(await service.getJobGoods(param(req, "jobId"), actorFrom(req)));
});

// Open demand across active jobs (planned-but-not-issued) — the planner uses it to show TRUE free
// stock per item+warehouse. excludeJobId drops the job currently being edited.
export const getDemand = asyncHandler(async (req, res) => {
  const excludeJobId = (req.query["excludeJobId"] as string | undefined)?.trim() || undefined;
  res.json({ demand: [...(await service.getOpenDemand(excludeJobId)).values()] });
});

// Demand board for one warehouse: on-hand vs total planned per item, shortfalls first.
export const getWarehouseDemand = asyncHandler(async (req, res) => {
  res.json({ rows: await service.getWarehouseDemand(param(req, "warehouseId")) });
});

export const closeReconcile = asyncHandler(async (req, res) => {
  res.json(await service.closeReconcile(param(req, "jobId"), req.body as CloseReconcileInput, actorFrom(req)));
});

export const listDamaged = asyncHandler(async (req, res) => {
  const { rows, counts } = await service.listDamaged(
    {
      warehouseId: queryStr(req.query["warehouseId"]),
      customerId: queryStr(req.query["customerId"]),
      ownerType: queryStr(req.query["ownerType"]),
      search: queryStr(req.query["search"]),
      countsOnly: queryStr(req.query["countsOnly"]) === "1",
    },
    actorFrom(req),
  );
  // `counts` rides along with every read so the screen's pool switcher never needs a second call —
  // and never has to derive its own navigation from the rows it just filtered away.
  res.json({ damaged: rows, counts });
});

// GET /goods-management/damaged/history — every damage report + restore behind ONE damaged row.
// Addressed by the balance's natural key rather than its id, so the caller can drill in straight
// from a list row without a second lookup. Validated here (a query string has no body schema):
// ownerType decides WHICH id is the required one, and sending the wrong one would silently match a
// different balance's key — so a mismatch is rejected rather than quietly answered.
export const getDamagedHistory = asyncHandler(async (req, res) => {
  const warehouseId = queryStr(req.query["warehouseId"])?.trim();
  const ownerType = queryStr(req.query["ownerType"])?.trim();
  const irmItemId = queryStr(req.query["irmItemId"])?.trim() || null;
  const customerStockEntryId = queryStr(req.query["customerStockEntryId"])?.trim() || null;

  if (!warehouseId) throw badRequest("warehouseId is required.");
  if (ownerType !== "company" && ownerType !== "customer") {
    throw badRequest("ownerType must be 'company' or 'customer'.");
  }
  if (ownerType === "company" && !irmItemId) throw badRequest("irmItemId is required for company-owned stock.");
  if (ownerType === "customer" && !customerStockEntryId) {
    throw badRequest("customerStockEntryId is required for customer-owned stock.");
  }

  res.json(
    await service.getDamagedHistory(
      {
        warehouseId,
        ownerType,
        // Force the key's unused socket to null. A company row is keyed with customerStockEntryId
        // null (and vice versa), so passing both would match nothing at all.
        irmItemId: ownerType === "company" ? irmItemId : null,
        customerStockEntryId: ownerType === "customer" ? customerStockEntryId : null,
      },
      actorFrom(req),
    ),
  );
});

// The window is NOT a query parameter. It comes from Settings → Operations and nowhere else, so
// "overdue" means one thing across the tab, the Inventory Hub and anything added later. A `?days=`
// override used to exist; it was the seam that let a caller produce a list of jobs that were not
// overdue by the company's own rule. The response reports the window it used so the screen can label
// itself honestly.
export const listOverdue = asyncHandler(async (req, res) => {
  res.json(
    await service.getOverdueView(actorFrom(req), {
      warehouseId: queryStr(req.query["warehouseId"])?.trim() || undefined,
      search: queryStr(req.query["search"]) ?? undefined,
      engineerId: queryStr(req.query["engineerId"])?.trim() || undefined,
      issuedFrom: queryStr(req.query["issuedFrom"])?.trim() || undefined,
      issuedTo: queryStr(req.query["issuedTo"])?.trim() || undefined,
      page: queryInt(req.query["page"]),
      pageSize: queryInt(req.query["pageSize"]),
    }),
  );
});


// GET /goods-management/overdue/groups — the same selection as /overdue, folded per warehouse and
// per engineer for the dashboard's Overdue Holdings drill-down. Bounded by entity count, never by
// job count, so it stays a summary read however long the backlog is. Same window rule as above: it
// comes from Settings and is reported in the response, never accepted from the caller.
export const listOverdueGroups = asyncHandler(async (req, res) => {
  res.json(
    await service.getOverdueGroups(actorFrom(req), {
      warehouseId: queryStr(req.query["warehouseId"])?.trim() || undefined,
      search: queryStr(req.query["search"]) ?? undefined,
      engineerId: queryStr(req.query["engineerId"])?.trim() || undefined,
      issuedFrom: queryStr(req.query["issuedFrom"])?.trim() || undefined,
      issuedTo: queryStr(req.query["issuedTo"])?.trim() || undefined,
    }),
  );
});

// POST /goods-management/damaged/report — move units from usable stock into the damaged pool.
export const reportDamage = asyncHandler(async (req, res) => {
  const result = await service.reportWarehouseDamage(req.body as ReportDamageInput, actorFrom(req));
  res.status(201).json(result);
});

// POST /goods-management/damaged/restore — restore damaged units back to usable stock.
export const restoreDamaged = asyncHandler(async (req, res) => {
  const result = await service.restoreDamaged(req.body as RestoreDamagedInput, actorFrom(req));
  res.status(201).json(result);
});
