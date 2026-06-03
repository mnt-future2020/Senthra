# Senthra — Client Requirements (Inputs & Responses)

> ⚠️ **DRAFT — NOT FINAL.** This is for *understanding the project*, captured from the
> client exchange. Details will change; always re-confirm before treating as fixed.
>
> **Sources:**
> - `Client_Inputs_Required.pdf` — MnT's list of 17 inputs needed **from** the client.
> - `Client Requirements Specification_Response 1.docx` — client's **Response 1** (answers items 01–09 only; 10–17 still pending).
>
> **Project:** Stock & Inventory Management System ("Senthra") · built by **MnT — Magizh NexGen Technologies** for a UK telecom field-services client.

---

## Item-by-item: what MnT asked → what the client answered

### 01. Sample Barcode Image
- **Ask:** Actual **Code 128** barcode sample + digit length + prefix structure.
- **Client:** Barcode configuration **varies per product / customer / manufacturer** (no single fixed format). Sample image provided in their doc.

### 02. Senthra Code Format (manual fallback code)
- **Ask:** Structure of the manual fallback code (PDF example: `SEN-2024-0001`).
- **Client:** **Depends per customer.** e.g. *Electra Networks* → `EN-2026-0001`.

### 03. Sample Delivery Note
- **Ask:** Copy/photo of the delivery-note format suppliers currently use.
- **Client:** Sample delivery note from supplier for **IRM** provided (example in doc).

### 04. Sample Purchase Order
- **Ask:** Current PO template used by the client.
- **Client:** Example provided in doc.

### 05. Sample Job Pack Excel
- **Ask:** Job-pack Excel to design the parsing logic (fields/columns/layout).
- **Client:** **To be provided later — after Phase 1 completion.** *(⇒ delivery is phased.)*

### 06. Category-Specific Product Custom Fields
- **Ask:** Category-specific spec fields per product type (beyond standard name/SKU/category/unit/price).
- **Client:**
  - **Customer equipment** → categorised by **SKU or Part codes, individual to each customer.**
  - **IRM** → used company-wide, by all Project Managers.
  - Example custom fields per category:
    - **Power cables:** Length (metres), LSOH, Armoured
    - **Nuts & Bolts:** material (Stainless steel / brass / copper), Sizes (M6 / M8 / M10)
    - **Fibres:** Multimode / Singlemode, Lengths, SC / LC connection, Duplex / Simplex
    - **Cat5/e, Cat6:** Roll of (Cat6 cable)
  - ⇒ Products need **flexible per-category custom attributes**.

### 07. Unit of Measurement (UoM) List
- **Ask:** Full list of units (kg, metre, piece, box, roll, litre, etc.).
- **Client:** **Metric measurements** / **Packs** (e.g. "Packs of 20 M6 Washers") / **Rolls** (e.g. "Roll of packaging tape").

### 08. Damage / Defect Classifications
- **Ask:** Classification for returns (PDF suggested Minor / Major / Scrap / Repairable).
- **Client:** **Minor Damage | Major Damage | Scrap Inventory | Repairable Stock | Return to warehouse** (5 categories).

### 09. Finance Report Templates
- **Ask:** Sample weekly & monthly report templates currently produced.
- **Client:** *"Please expand?"* — **bounced back to MnT** for more detail. **PENDING.**

---

## Items 10–17 — asked by MnT, **NOT yet answered** in Response 1
10. **Customer-Facing Report Sample** — which fields are visible to customers vs hidden.
11. **Logo, Brand Colors & Font** — for UI branding.
12. **Physical Barcode Scanner Model** — brand/model (compatibility check).
13. **Standard Fields Coverage** — MnT includes standard fields per entity (Customer, Project, Warehouse, Supplier, Engineer, Product…) by default; client to list any extras.
14. **Currency & Tax Format** — confirm currency (**£ GBP**) + whether VAT % shows in reports/invoices.
15. **Date Format & Time Zone** — confirm **DD/MM/YYYY**, number `1,000.00`, timezone **GMT / BST**.
16. **Working Hours / Business Days** — e.g. **Mon–Fri, 9 AM–5 PM** (so low-stock alerts & scheduled reports fire only in working hours).
17. **Additional Requirements Clause** — further requirements may be raised during development.

---

## Key takeaways for the build
- **Barcode = Code 128**, scanned; format **varies per customer/product**. Manual fallback code is **per-customer** (e.g. `EN-2026-0001`).
- **Two stock types confirmed** (matches the business-flow doc): **Customer equipment** (per-customer SKU/Part codes) vs **IRM** (company-wide, used by all PMs).
- **Products need per-category custom fields** (dynamic attributes) — a real data-model implication.
- **UK localization:** GBP (£), DD/MM/YYYY, `1,000.00`, GMT/BST, Mon–Fri 9–5 (gates alerts/reports).
- **5 damage/defect categories.**
- **Phased delivery** — Phase 1 first; job-pack Excel parsing comes after.
- **Still open:** finance report templates (09), and all of 10–17 (incl. branding, scanner model, customer-report field visibility, tax format).
