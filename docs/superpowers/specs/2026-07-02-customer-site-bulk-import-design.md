# Customer Site Bulk Import — Design

**Date:** 2026-07-02
**Status:** Approved (design), pending implementation plan
**Scope:** Per-customer bulk upload of delivery/installation sites from an Excel/CSV sheet, with a preview-and-confirm step.

## 1. Problem & goal

Onboarding a customer today means adding each site one at a time through `SiteModal` (`POST /customers/:id/sites`). Customers arrive with an Excel sheet of dozens–hundreds of sites. We need a **prod-grade bulk import**: upload a sheet, preview what will happen (with per-row validation), then import — safe to re-run, and manageable at large volumes. Addresses must land in the correct structured fields (`addressLine1/2`, `city`, `county`, `postcode`, `country`) so downstream job auto-fill and the engineer "Directions" link work.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Scope / entry point | **Per-customer**, on the customer's **Sites** tab (no customer column in the sheet). |
| Import flow | **Preview + partial import** — validate all rows, show a preview, import only the valid/new rows, report the rest. |
| Duplicate handling | **Skip duplicates** — match on `name + postcode` (case-insensitive) against existing sites AND within the file; skipped rows are reported. |
| Technical approach | **Approach A** — parse the sheet in the browser (SheetJS, lazy-loaded), send valid rows as JSON to a new bulk endpoint; backend re-validates authoritatively. No backend file-upload/multipart. |

## 3. Non-goals (YAGNI)

- No global/multi-customer import screen (sheet has no customer column).
- No "update existing site" / upsert by code — import only **creates** new sites.
- No server-side file parsing, no multipart/multer, no temp files.
- No background job/queue — import runs synchronously in sequential client batches.
- No mapping of arbitrary/custom columns — a fixed, documented column set with a few aliases.
- **No persistent "Import Job" entity / import-history screen** (review #1, #8). The single audit entry (enriched with filename + counts + duration) covers who/when/how-many; a browsable history with re-downloadable reports is a clean follow-up, not v1.
- **No server-side preview / dry-run ID** (review #5). It conflicts with Approach A: the client already holds the validated rows, so re-POSTing them *is* the commit. A server preview store would add ephemeral state (and effectively Approach B) for no gain.
- **No resumable / refresh-surviving import** (review #6). Skip-duplicate makes a re-upload after a crash safe for free — already-created rows are skipped on the retry, so recovery is "upload the same file again". Not worth a job/queue for dozens–hundreds of sites.

## 4. Architecture overview

```
Browser (SiteImportModal)
  1. read .xlsx/.csv  ── SheetJS (dynamic import) ──▶ raw rows
  2. map headers → validate each row (mirrors siteSchema) → PREVIEW
  3. on Import: POST valid rows in sequential batches of ≤500
        │
        ▼
Backend  POST /customers/:id/sites/bulk   (perm customer_sites.create, bulkWriteLimiter)
  route: body = { sites: object[] }, array capped at 500
  service bulkAddSites():
     - load existing (name+postcode) dedupe keys for the customer
     - per row: siteSchema.safeParse → collect failures (partial success)
     - skip duplicates (existing + in-batch)
     - batch-geocode unique postcodes (postcodes.io bulk, 100/call, best-effort)
     - allocate a contiguous STE-#### block once, createMany
     - return { createdSites, skipped[], failed[] }
        │
        ▼
  Client aggregates batch results → RESULT step (counts + downloadable report)
```

**Trust boundary:** client-side validation is for preview UX only. The backend `bulkAddSites` re-validates every row with the same `siteSchema` used by single-add — the client is never trusted.

## 5. Components

### 5.1 Frontend — `lib/siteImport.ts` (pure logic, unit-tested)
Single-purpose module, no React, so it can be tested in isolation:
- `parseSheet(file): Promise<RawRow[]>` — dynamic `import("xlsx")`, read first sheet, `sheet_to_json`.
- `mapColumns(rawRow): SiteDraft` — case-insensitive header match + alias table (`post code`→`postcode`, `address line 1`→`addressLine1`, `contact`/`contact person`→`contactPerson`, `contact number`/`phone`→`contactNumber`, `town`→`city`, etc.).
- `validateRow(draft): { ok: true, value } | { ok: false, error }` — mirrors `siteSchema` (name required ≤120; addressLine1/2 ≤200; city/county/country ≤120; `UK_POSTCODE_RE` if postcode present; status ∈ {active,inactive}; phone format). Blank `country` defaults to "United Kingdom"; blank `status` defaults to `active`.
- `dedupeKey(name, postcode): string` — `name.trim().toLowerCase() + "|" + (postcode||"").toLowerCase().replace(/\s+/g,"")`. Shared shape with the backend.
- `classifyRows(drafts, existingKeys): PreviewRow[]` — tags each row `new | duplicate | error` (error wins; duplicate checked against existingKeys + earlier new rows in the file).
- `buildTemplate(): Blob` — SheetJS-generated `.xlsx` (header + one example row).
- `buildReport(rows): Blob` — a single `.xlsx` of every processed row with **all original columns preserved** plus two added columns: `status` (`created` | `skipped` | `error`) and `reason`. One combined report (not three separate downloads); the user filters/fixes the `error` rows and re-uploads directly.

`PreviewRow = { rowNumber, draft, status: "new"|"duplicate"|"error", reason?: string }`.

### 5.2 Frontend — `SiteImportModal.tsx` (thin)
3 steps (Upload → Preview → Result). Holds file/preview/result state, calls `lib/siteImport` + `customerService.bulkAddSites`. Sends `new` rows in sequential batches of ≤500 with a progress indicator; aggregates `{ created, skipped, failed }` across batches. On finish, calls `onImported()` so the Sites list refetches.

### 5.3 Frontend — wiring
- `CustomerDetail.tsx`: add **"Import sites"** button in the Sites tab header next to "Add site", permission-gated (`customer_sites.create`), opens the modal.
- `services/customer.service.ts`: `bulkAddSites(customerId, sites: SitePayload[]): Promise<BulkSiteResult>`.
- `package.json`: add `xlsx` (SheetJS). Imported dynamically inside `lib/siteImport.ts` so it is not in the initial bundle.

### 5.4 Backend — endpoint & layers
- `customer.routes.ts`: `POST /:id/sites/bulk` → `requirePermission("customer_sites.create")`, `bulkWriteLimiter`, `validateBody(bulkSiteSchema)`, `customerController.bulkAddSites`.
- `customer.validation.ts`: `bulkSiteSchema = z.object({ fileName: z.string().trim().max(260).optional(), sites: z.array(z.record(z.string(), z.unknown())).min(1, "Add at least one site.").max(500, "Import up to 500 sites per batch.") })`. Deliberately loose per-row (raw objects) so the **service** can validate each row and report per-row failures instead of all-or-nothing. `fileName` is metadata for the audit entry only.
- `customer.controller.ts`: `bulkAddSites` — thin, passes `req.body.sites` + `req.body.fileName` + actor to the service, returns the result JSON.
- `customer.service.ts`: `bulkAddSites(customerId, rows, fileName, actor): Promise<BulkSiteResult>`:
  - `requireCustomer(customerId)`.
  - Build the existing-key set from the customer's current sites (name+postcode). Add a lightweight `customerRepo.findSitesByCustomer(customerId)` (`customerSite.findMany({ where: { customerId }, select: { name, postcode } })`) — the repo currently only loads sites via the customer include, so this focused query avoids pulling the whole customer graph.
  - For each row (tracking original index): `siteSchema.safeParse` → on failure push to `failed`; else compute `dedupeKey` → if in existing set or already-seen-in-batch push to `skipped`; else stage `toSiteData(input)` and remember the key.
  - Batch-geocode the unique staged postcodes via `geocodePostcodesBulk` and attach coords (best-effort; unknown → null).
  - `customerRepo.createSitesBulk(customerId, stagedData)` (atomic code-block reservation + `createMany` + refetch created rows).
  - One audit entry `customer.sites.bulk_imported` with `fileName`, created/skipped/failed counts, and duration (ms). No per-row rows in the audit payload (keeps the log lean); the per-row detail lives in the response + downloadable report.
  - Return `{ createdSites: PublicCustomerSite[], skipped: RowNote[], failed: RowNote[] }`, `RowNote = { row: number, name: string, reason: string }`.
- `customer.repository.ts`: `createSitesBulk(customerId, data: SiteData[]): Promise<CustomerSite[]>` — **race-safe code allocation, mirroring the existing atomic counter.** Reserve a contiguous block of `N = data.length` codes with a SINGLE atomic op: `prisma.counter.update({ where: { key: "STE:"+customerId }, data: { seq: { increment: N } } })`. The returned `seq` is the block END, so the reserved range is `seq-N+1 … seq`; assign `STE-####` from it. If the counter doesn't exist yet, seed it (`highestNestedSuffix` of existing codes, then `counter.create`, tolerating a concurrent-seed `P2002`) — identical bootstrap to `allocateNestedCode`. Then `prisma.customerSite.createMany` and refetch the created rows by their code range to return them.
  - **Transaction boundary (verified):** the counter `$inc` MUST stay a **standalone atomic op — NOT inside a `withTransaction`**. Putting it in a transaction with `createMany` exposes it to MongoDB write-conflict aborts (`TransientTransactionError`) under concurrent imports, which `prisma.$transaction` does not auto-retry. The standalone `$inc` has no such risk. `createMany` MAY be wrapped in `withTransaction` for all-or-nothing batch insert; on failure the reserved codes are simply "burned" (a sequence gap) — the same accepted failure mode single-add already has (allocate → create). Never a duplicate.
  - ⚠️ **Do NOT** allocate by reading `max(existing code)+1` per batch — that bypasses the atomic counter and, because the site `code` has no unique DB constraint, would let two concurrent imports (or an import + a single add) mint duplicate `STE-####`. The single-add path is already race-safe via the counter; the bulk path MUST use the same counter (incremented by N) to stay so.
  - **Optional hardening (recommended):** add `@@unique([customerId, code])` to `CustomerSite` as defense-in-depth so any future allocation bug fails loudly instead of silently duplicating. Codes are counter-allocated so existing data should already satisfy it; verify before enabling the index (follow the repo's established "ensure-index with pre-check" pattern if there's any risk of legacy dupes).
- `lib/geocode.ts`: `geocodePostcodesBulk(codes: string[]): Promise<Map<string, {latitude,longitude}>>` — postcodes.io `POST /postcodes` in chunks of 100; best-effort (network/unknown → omitted from the map). Existing single `geocodePostcode` stays for single-add.

## 6. Data contracts

**Request** `POST /customers/:id/sites/bulk`
```jsonc
{
  "fileName": "lobbi-sites.xlsx",   // optional, for the audit trail
  "sites": [
    { "name": "Leeds HQ", "addressLine1": "1 Basinghall St", "city": "Leeds",
      "county": "West Yorkshire", "postcode": "LS1 4DY", "country": "United Kingdom",
      "contactPerson": "Sam", "contactNumber": "07700 900111", "status": "active" }
  ]
}
```

**Response**
```jsonc
{
  "createdSites": [ /* PublicCustomerSite[] */ ],
  "skipped": [ { "row": 5, "name": "Leeds HQ", "reason": "Already exists (name + postcode)." } ],
  "failed":  [ { "row": 9, "name": "", "reason": "Site name is required." } ]
}
```
`row` is the 1-based sheet row number (carried from the client so messages point at the user's file).

## 7. Validation rules

Authoritative rules = the existing `siteSchema` (unchanged), applied per row in the service:
- `name` required, ≤120.
- `addressLine1`, `addressLine2` ≤200. `city`, `county`, `country` ≤120.
- `postcode` optional; if present must pass the UK postcode field validation.
- `contactNumber` optional; phone-field format.
- `status` optional; `active | inactive`; default `active`.
- `country` blank → "United Kingdom".

Dedupe key (client + server identical): `name.trim().toLowerCase() + "|" + postcode.toLowerCase().replace(/\s+/g,"")`.

## 8. Scale & performance

- **Batching:** client sends `new` rows in sequential batches of ≤500 (one request each) with progress; results aggregated. Soft guard ~5,000 rows total with a clear "split the file" message — protects against accidental giant uploads.
- **Body size:** a site row is ~300 bytes of JSON; 500 rows ≈ 150 KB, far under the 5 MB `express.json` limit.
- **Geocoding:** `geocodePostcodesBulk` calls postcodes.io bulk (100/call), so 500 sites ≈ 5 external calls, not 500.
- **Code allocation:** contiguous block computed once per batch + `createMany` — avoids the per-insert `findMany` that `allocateNestedCode` does for single-add.
- **Rate limit:** dedicated `bulkWriteLimiter` sized for a handful of sequential batches per window.

## 9. Error handling

- Malformed/upgradeable file (not a spreadsheet, no rows, no `name` column) → friendly message at the Upload step, nothing sent.
- Per-row validation failures and duplicates → never block the batch; reported in Preview and the final report.
- A failed batch request (network/5xx) → the modal shows which batch failed, keeps successful batches' results, and lets the user retry the remaining rows.
- Geocoding failure for a postcode → site is still created with `latitude/longitude = null` (identical to single-add today).

## 10. Testing

**Backend (vitest):**
- `bulkAddSites`: mixed valid/invalid rows → correct `createdSites/skipped/failed` partition (partial success).
- Dedupe: against existing sites and within the batch.
- Geocode mapping best-effort: unknown postcode → null coords, still created.
- `createSitesBulk`: contiguous `STE-####` allocation with existing codes present.
- `bulkSiteSchema`: rejects empty array and >500 rows.

**Frontend (unit):**
- `lib/siteImport`: column mapping + aliases; `validateRow` limits and postcode/status rules; defaults (country/status); `dedupeKey`; `classifyRows` (error vs duplicate vs new, in-file dupes); template + report generation shape.

## 11. Files

**New**
- `frontend/src/lib/siteImport.ts` (+ `siteImport.test.ts`)
- `frontend/src/components/dashboard/customers/SiteImportModal.tsx`

**Changed — backend**
- `customer.validation.ts` (`bulkSiteSchema`)
- `customer.service.ts` (`bulkAddSites`, dedupe helper)
- `customer.repository.ts` (`createSitesBulk`)
- `customer.controller.ts` (`bulkAddSites`)
- `customer.routes.ts` (`POST /:id/sites/bulk`, `bulkWriteLimiter`)
- `lib/geocode.ts` (`geocodePostcodesBulk`)
- `middleware/rateLimit.middleware.ts` (`bulkWriteLimiter`)
- Tests: `customer.service.test.ts`, `customer.validation.test.ts`

**Changed — frontend**
- `services/customer.service.ts` (`bulkAddSites`, `BulkSiteResult` type)
- `components/dashboard/customers/CustomerDetail.tsx` (Import button)
- `package.json` (add `xlsx`)

## 12. Open follow-ups (out of scope)

- Global multi-customer import.
- Upsert-by-code (bulk edit existing sites).
- Applying the same import pattern to other entities (customers, warehouses).
- Persistent import-history screen with re-downloadable reports (review #1).

## 13. External review — assessment (2026-07-02)

An external review proposed 8 enhancements. Each was checked against **this** codebase, not accepted by default:

| # | Suggestion | Verdict | Reasoning |
|---|---|---|---|
| 3 | Concurrency on code allocation | **Accepted (design fix)** | Verified: single-add is already race-safe via an atomic per-customer `Counter`. The *first draft of this spec* proposed `max+1` block allocation, which would bypass that counter — and site `code` has no unique constraint, so concurrent imports could mint duplicate `STE-####`. Fixed in §5.4: reserve the block with one atomic `counter.update({ seq: { increment: N } })`. Optional `@@unique([customerId, code])` hardening noted. |
| 2 | Richer audit metadata | **Accepted (light)** | Added `fileName` + created/skipped/failed counts + duration to the single audit entry. Rejected per-row rows in the audit payload (log bloat) — per-row detail lives in the response + report. |
| 4 | Error report includes original row | **Already covered** | `buildReport` emits every original column; clarified to add `status` + `reason` columns. |
| 7 | Success/failed/skipped reports | **Accepted (light)** | One combined report with a `status` column, not three downloads. |
| 1 | Persistent Import Job entity | **Rejected (v1)** | New model + UI. Audit already records who/when/counts. Follow-up (§12). |
| 5 | Server-side preview / dry-run ID | **Rejected** | Conflicts with Approach A — client holds the validated rows; re-POST *is* the commit. Would add server ephemeral state we deliberately avoided. |
| 6 | Resumable / survive-refresh | **Rejected** | Skip-duplicate already makes re-upload after a crash safe. No queue needed at this scale. |
| 8 | Separate import-summary entity | **Folded into #2** | Same data captured in the enriched audit entry; no new entity. |

Net effect: #3 (important) and #2 (light) change the design above; #4/#7 were clarified; #1/#5/#6/#8 are documented rejections in §3/§12.

## 14. Implementation verification (2026-07-02)

Three implementation-risk points were verified against the actual code and live data before committing to §5.4:

1. **Counter cold-start race** — ✅ safe. `allocateNestedCode` seeds via `counter.create` (key `@unique`), tolerates the concurrent-seed `P2002`, then does the atomic `$inc`; concurrent bootstraps get distinct numbers. The bulk path replicates this with `increment: N` → non-overlapping contiguous blocks.
2. **Transaction boundaries** — ✅ with a caveat now baked into §5.4: keep the counter `$inc` standalone (not inside `withTransaction`) to avoid un-retried Mongo write-conflict aborts; wrap only `createMany` if all-or-nothing insert is wanted. Gaps-on-failure are the same accepted behavior as single-add.
3. **`@@unique([customerId, code])` safety** — ✅ safe today. Read-only check of live data: 5 sites / 4 customers / **0 duplicate `(customerId, code)`** / 0 null codes / 4 aligned STE counters. Apply via `prisma db push`; re-run the check against production before enabling there.
