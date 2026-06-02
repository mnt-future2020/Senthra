# Senthra — Complete Business Flow

---

## PRE-REQUISITE SETUP ORDER

```
Step 1: Warehouses → Step 2: Suppliers → Step 3: Users & Roles
    → Step 4: IRM Inventory → Step 5: Customer Module
    → All flows ready!
```

---

## PRE-REQUISITE 1: WAREHOUSE SETUP (One-Time)

```
Admin creates warehouse locations
    │
    ├── Warehouse 1 (Leeds)
    ├── Warehouse 2 (London)
    └── Warehouse 3 (Manchester)
```

---

## PRE-REQUISITE 2: SUPPLIER SETUP (One-Time)

```
Admin / PM creates supplier master data
    │
    ├── Supplier Name: ABC Cables Ltd
    │   ├── Contact Person
    │   ├── Email / Phone
    │   └── Supplier Code: SUP-001
    │
    ├── Supplier Name: XYZ Hardware
    │   ├── Contact Person
    │   ├── Email / Phone
    │   └── Supplier Code: SUP-002
    │
    └── Supplier Name: CIENA
        ├── Contact Person
        ├── Email / Phone
        └── Supplier Code: SUP-003

    NOTE: Suppliers must be created before IRM items (Step 4)
    and Goods-In (FLOW 2) — because both need supplier dropdown.
```

---

## PRE-REQUISITE 3: USERS & ROLES SETUP (One-Time)

```
System Admin (IT Manager / HR / select PM) creates user accounts
    │
    ├── Field Engineers (40-60 users)
    │       • Company email + password
    │       • Role: Field Engineer
    │       • Assigned to project(s)
    │
    ├── Project Managers (3-4 users)
    │       • Role: Project Manager
    │
    ├── Project Coordinators
    │       • Role: Project Coordinator
    │
    ├── Warehouse Managers
    │       • Role: Warehouse Manager
    │       • Assigned to warehouse(s)
    │
    ├── Finance Director
    │       • Role: Finance Director
    │
    ├── HR Manager
    │       • Role: HR Manager
    │
    └── Customer PMs (per customer)
            • Role: Customer PM (read-only)
            • Linked to their customer account

    NOTE: Users must be created before any flow can work —
    PM needs account to create jobs, Engineer needs account
    to receive jobs, WH Manager needs account to scan stock.
```

---

## PRE-REQUISITE 4: IRM INVENTORY SETUP (One-Time)

```
Admin / PM creates IRM items + assigns warehouse stock:
    │
    ├── Item Name: Cable 5m
    ├── Category: [Cables ▼]
    ├── Unit: [Metres ▼]
    ├── Cost: £2.50
    ├── Supplier: [ABC ▼]
    │
    ├── Warehouse Stock:
    │   ┌─────────────┬───────┬──────────┐
    │   │ Warehouse   │ Qty   │ Aisle    │
    │   ├─────────────┼───────┼──────────┤
    │   │ Leeds       │ [500] │ [Shelf 3A]│
    │   │ London      │ [300] │ [Shelf 2C]│
    │   │ Manchester  │ [0]   │ [—]      │
    │   └─────────────┴───────┴──────────┘
    │
    ├── Threshold: [50] (minimum stock level)
    │
    ▼
[CREATE] → Done!
    │
    │ Item created + stock assigned to warehouses automatically

After setup — system has full picture:

    ┌────────────┬─────────┬───────────┬──────────┬───────────┐
    │ Item       │ Leeds   │ London    │Manchester│ Total     │
    ├────────────┼─────────┼───────────┼──────────┼───────────┤
    │ Cable 5m   │ 500     │ 300       │ 0        │ 800       │
    │ Connectors │ 200     │ 150       │ 100      │ 450       │
    │ Cable Ties │ 1000    │ 500       │ 500      │ 2000      │
    └────────────┴─────────┴───────────┴──────────┘───────────┘

    New stock arrives after setup → Goods-In flow (FLOW 2) handles it.
```

---

## PRE-REQUISITE 5: CUSTOMER MODULE SETUP (One-Time)

```
System Admin / PM sets up Customer Master Data in Senthra
    │
    ├──► Customer Profile
    │       • Customer Name: BT
    │       • Contact Person: John Smith
    │       • Email / Phone
    │       • Customer Code: CUST-001
    │
    ├──► Customer Projects
    │       • Project 1: BT Core Migration
    │       • Project 2: BT RAN Rollout
    │       • Project 3: BT IP Upgrade
    │
    ├──► Customer Stock Catalogue
    │       • SFP-LX (SKU: NTTP06CFE6) — Category: Optical
    │       • SFP-SX (SKU: NTTP06AFE6) — Category: Optical
    │       • Server Card X — Category: Core
    │       • ... (all items this customer uses)
    │
    └──► Customer Sites (optional)
            • Leeds Basinghall — LS1 5DZ
            • Manchester Exchange — M1 2AB
            • ...

    NOTE: This is done ONCE per customer.
    After setup, PM can create jobs quickly using dropdowns.
    New items/sites can be added anytime.
```

---

## FLOW 1: NEW JOB ARRIVES (Customer → PM → Engineer)

```
Customer (BT, Vodafone etc.)
    │
    │ Contacts Senthra via: Phone call / Email / Portal
    │ "Leeds site la 2 SFP cards install pannanum"
    │
    ▼
PM logs into Senthra → CREATE JOB PACK
    │
    ├──► Select Customer:  [BT ▼]              (dropdown, auto-loads below)
    ├──► Select Project:   [Core Migration ▼]   (dropdown from BT's projects)
    │
    ├──► Customer Stock Required:
    │       ┌────────────┬───────────┬──────────┐
    │       │ Item       │ Available │ Required │  ← only items with stock show
    │       ├────────────┼───────────┼──────────┤
    │       │ SFP-LX     │ 45        │ [1]      │
    │       │ SFP-SX     │ 28        │ [1]      │
    │       └────────────┴───────────┴──────────┘
    │
    ├──► IRM Required:
    │       ┌────────────┬───────────┬──────────┐
    │       │ Item       │ Available │ Required │  ← only items with stock show
    │       ├────────────┼───────────┼──────────┤
    │       │ Cable 5m   │ 100       │ [2]      │
    │       │ Connectors │ 500       │ [4]      │
    │       └────────────┴───────────┴──────────┘
    │
    ├──► Site:      [Leeds Basinghall ▼]  (dropdown or type new)
    ├──► Deadline:  [23/03/2026]
    ├──► Priority:  [Standard ▼]
    ├──► Engineer:  [Karthik ▼]
    ├──► Notes:     [Free text]
    │
    ▼
[CREATE JOB PACK] → Done!
    │
    ▼
Engineer gets notification (In-app + Email)
    │
    │ "Job assigned: Leeds Basinghall - 1x SFP-LX, 1x SFP-SX"
    │
    ▼
Engineer opens app → Sees job details
    │
    ▼
Goes to warehouse → Collects stock (FLOW 3)
    │
    ▼
Goes to site → Installs hardware
    │
    ▼
Marks job complete in app
    │
    │ Updates stock: "Used 1x LX, 1x SX"
    │
    ▼
PM dashboard auto-updates → Job Status: COMPLETE
```

---

## FLOW 2: STOCK COMES INTO WAREHOUSE (Goods-In — IRM Stock)

```
PM / Company orders IRM from external suppliers
    │
    │ Cables, connectors, screws, tools etc.
    │ Purchase Order (PO) raised for the order
    │
    ▼
Supplier delivers to warehouse
    │
    ▼
Warehouse Manager receives delivery
    │
    ├──► Checks delivery details against PO:
    │       • Supplier name
    │       • PO number
    │       • Delivery date
    │       • Delivery person
    │
    ├──► Physical quantity check:
    │       │
    │       ├── All items received (e.g., 10 ordered, 10 received)
    │       │       │
    │       │       ▼
    │       │   Marks delivery as COMPLETE
    │       │
    │       └── Partial delivery (e.g., 10 ordered, 7 received)
    │               │
    │               ▼
    │           Marks as PARTIAL DELIVERY
    │           Ticket stays OPEN with reference
    │           Remaining 3 items tracked as pending
    │           When remaining items arrive later → linked to same PO
    │
    ▼
Warehouse Manager adds stock to system
    │
    │ Item already exists in system (created in PRE-REQ 4)
    │ So WH Manager just:
    │
    ├── Select item: [Cable 5m ▼]     ← dropdown from existing inventory
    ├── Quantity received: [100]
    ├── PO reference: [PO-2026-0451]
    │
    │ (Item name, cost, category, supplier, aisle —
    │  already in system from PRE-REQ 4, no need to re-enter)
    │
    ▼
System auto-updates (real-time)
    │
    ├──► IRM stock count increases (Cable 5m: was 500 → now 600)
    ├──► Finance data updated (cost recorded based on existing unit cost)
    ├──► PO linked to delivery record
    │
    ▼
PM gets notification: "IRM delivery received — PO-2026-0451"
```

---

## FLOW 3: STOCK LEAVES WAREHOUSE (Goods-Out)

```
Engineer needs stock for a job
    │
    ▼
PM / Administrator authorizes dispatch
    │
    │ No separate approval workflow needed
    │ Just tracking + system alignment
    │
    ▼
Engineer goes to warehouse
    │
    ▼
Warehouse Manager gives stock to engineer
    │
    ├──► Customer Stock items scanned OUT
    │       • Each item barcode scanned
    │       • Stock count decreases automatically
    │
    ├──► IRM items scanned OUT / recorded
    │       • Cables, connectors etc.
    │       • Linked to project + PM
    │
    ▼
System records:
    │
    │ WHO: Engineer name (Karthik)
    │ WHAT: 1x SFP-LX (serial: ABC123), 5m fibre cable
    │ WHEN: 01/06/2026 08:30
    │ WHICH PROJECT: BT Leeds Core Migration
    │ AUTHORIZED BY: PM Ravi
    │
    ▼
Dashboards update (real-time):
    │
    ├──► Warehouse stock count decreases
    ├──► Engineer's personal stock count increases
    ├──► PM sees engineer now has the kit
    ├──► Customer dashboard updates (their stock moved)
    │
    ▼
Audit trail entry created
```

---

## FLOW 4: ENGINEER USES STOCK ON SITE

```
Engineer arrives at site
    │
    │ Opens Senthra app
    │ Views: Job details + required kit list
    │
    ▼
Engineer installs hardware
    │
    │ Uses customer stock (SFP cards) + IRM (cables, connectors)
    │
    ▼
Engineer updates stock in app
    │
    ├──► "Used 1x SFP-LX" → Stock decreases from engineer's inventory
    ├──► "Used 3m fibre cable" → IRM decreases
    │
    ▼
Engineer marks job COMPLETE
    │
    ▼
System updates:
    │
    ├──► PM dashboard: Job status = Complete
    ├──► Engineer stock: Updated
    ├──► Audit trail: Full record of what was used where
```

---

## FLOW 4B: ENGINEER DASHBOARD

```
Engineer logs into Senthra (app or web)
    │
    │ Company email + password
    │
    ▼
Engineer Dashboard shows:
    │
    ├──► My Assigned Jobs
    │       ┌──────────┬─────────────────┬────────────┬──────────┐
    │       │ Job #    │ Site            │ Deadline   │ Status   │
    │       ├──────────┼─────────────────┼────────────┼──────────┤
    │       │ 5561592  │ Leeds Basinghall│ 23/03/2026 │ Pending  │
    │       │ 5561601  │ Manchester Exch │ 28/03/2026 │ In Progress│
    │       │ 5561589  │ London Bridge   │ 15/03/2026 │ Complete │
    │       └──────────┴─────────────────┴────────────┴──────────┘
    │
    ├──► My Customer Stock (separate section)
    │       ┌──────────┬──────────┬───────┐
    │       │ Item     │ Customer │ Qty   │
    │       ├──────────┼──────────┼───────┤
    │       │ SFP-LX   │ BT       │ 3     │
    │       │ SFP-SX   │ BT       │ 2     │
    │       │ Router A │ Vodafone │ 1     │
    │       └──────────┴──────────┴───────┘
    │
    ├──► My IRM Stock (separate section)
    │       ┌──────────┬───────┐
    │       │ Item     │ Qty   │
    │       ├──────────┼───────┤
    │       │ Cable 5m │ 10    │
    │       │Connectors│ 25    │
    │       └──────────┴───────┘
    │
    ├──► Low Stock Alerts
    │       "SFP-SX: 2 remaining — threshold: 3 — LOW!"
    │
    ├──► Recent Activity
    │       "01/06 — Collected 1x SFP-LX from Leeds warehouse"
    │       "31/05 — Returned 1x Cable 5m to London warehouse"
    │       "30/05 — Transferred 1x SFP-SX to Engineer B"
    │
    ▼
Engineer can:
    │
    ├──► View job details (tap on any job)
    ├──► Update stock after site visit
    ├──► Initiate stock transfer to another engineer (FLOW 6)
    └──► See notifications (new jobs, alerts)
```

---

## FLOW 5: STOCK RETURN (Engineer → Warehouse)

### 5A: Good Stock Return

```
Engineer has unused stock after job
    │
    │ e.g., Ordered 2 SFP cards, used only 1
    │
    ▼
Engineer brings stock back to warehouse
    │
    ▼
Warehouse Manager scans items IN
    │
    ├──► Items added back to warehouse inventory
    ├──► Engineer's stock count decreases
    ├──► Warehouse stock count increases
    │
    ▼
System logs:
    │
    │ RETURN BY: Karthik
    │ ITEM: 1x SFP-LX (serial: DEF456)
    │ REASON: Unused
    │ DATE: 02/06/2026
    │
    ▼
Audit trail updated
```

### 5B: Damaged / Defective Stock Return

```
Engineer finds stock is damaged / defective
    │
    ▼
Engineer brings back to warehouse
    │
    ▼
Warehouse Manager processes through SEPARATE workflow
    │
    │ NOT added back to normal inventory
    │
    ├──► Marked as DAMAGED / DEFECTIVE
    ├──► Reason recorded
    ├──► Separate storage / disposal process
    │
    ▼
System logs:
    │
    │ RETURN BY: Karthik
    │ ITEM: 1x SFP-SX (serial: GHI789)
    │ CONDITION: Damaged
    │ REASON: "Pin bent during transport"
    │ DATE: 02/06/2026
    │
    ▼
PM + Warehouse Manager notified
    │
    ▼
Audit trail updated
```

---

## FLOW 6: ENGINEER-TO-ENGINEER STOCK TRANSFER

```
Engineer A has extra SFP-LX card
Engineer B needs SFP-LX card urgently
    │
    ▼
Transfer initiated in Senthra app
    │
    │ Engineer A: "Transfer 1x SFP-LX to Engineer B"
    │ OR
    │ PM initiates transfer on behalf
    │
    ▼
System processes:
    │
    ├──► Engineer A stock: -1 SFP-LX
    ├──► Engineer B stock: +1 SFP-LX
    │
    ▼
Both dashboards update automatically
    │
    ▼
Audit trail:
    │
    │ FROM: Engineer A (Karthik)
    │ TO: Engineer B (Suresh)
    │ ITEM: 1x SFP-LX (serial: JKL012)
    │ DATE: 01/06/2026 14:00
    │ REASON: "Urgent requirement for BT job"
    │
    ▼
PM gets notification of transfer
```

---

## FLOW 7: LOW STOCK ALERT + REORDER

```
System monitors stock levels continuously
    │
    ▼
Stock reaches threshold
    │
    │ e.g., Cable 5m threshold = 50, current count = 48
    │
    ▼
ALERT TRIGGERED
    │
    ├──► In-app notification to PM
    ├──► In-app notification to Warehouse Manager
    ├──► Email alert to both
    │
    ▼
Dashboard shows visual indicator
    │
    │ Normal = Green
    │ Low = Yellow/Orange
    │ Critical = Red
    │
    ▼
PM decides action:
    │
    ├──► Manual reorder: PM raises PO manually
    │
    └──► Auto reorder: System auto-generates reorder request
            │
            │ Like a job pack — ready-made PO with:
            │   • Item name
            │   • Quantity needed
            │   • Supplier (from existing item data)
            │   • Suggested order amount
            │
            ▼
        PM just reviews and clicks [APPROVE]
            │
            ▼
        Order placed → Supplier delivers → back to FLOW 2 (Goods-In)
```

---

## FLOW 8: UPDATE THRESHOLD

```
PM or Warehouse Manager needs to change existing threshold
    │
    │ (Initial threshold is set during item creation — PRE-REQ 4)
    │ (This flow is for updating/changing it later)
    │
    ▼
Goes to Item Settings
    │
    ├── Selects item: [Cable 5m ▼]
    ├── Current threshold: 50
    ├── New threshold: [100]
    │
    ▼
[UPDATE] → Done!
    │
    ▼
System monitors against new threshold
    │
    ▼
Audit trail: "PM Ravi changed Cable 5m threshold from 50 to 100"
```

---

## FLOW 9: CUSTOMER VIEWS THEIR STOCK

```
Customer PM logs into Senthra
    │
    │ Company email + password
    │ READ-ONLY access
    │
    ▼
Customer Dashboard shows:
    │
    ├──► Their stock in warehouse
    │       "SFP-LX: 45 in stock"
    │       "SFP-SX: 28 in stock"
    │       "Server Card X: 12 in stock"
    │
    ├──► Stock movements
    │       "5 SFP-LX dispatched on 01/06/2026"
    │       "10 SFP-SX received on 28/05/2026"
    │
    ├──► NO pricing / cost data shown
    │
    └──► High value items specially tracked
            "Server Card (£10,000) — Serial: MNO345 — Location: Warehouse 1, Shelf 2B"
    │
    ▼
Customer generates report
    │
    │ Filter: Date range, item type, project
    │ Export: Excel / CSV
    │
    │ Example: "November 2025 — How many SFP cards dispatched?"
    │ Report shows: 47 SFP cards, with dates + engineer names + sites
    │
    ▼
Customer downloads report
    │
    │ NO pricing shown in customer reports
```

---

## FLOW 10: FINANCE REPORTING

```
Finance Director logs into Senthra
    │
    ▼
Finance Dashboard shows:
    │
    ├──► Total IRM spend (this week / this month / custom)
    ├──► Spend by project
    ├──► Spend by supplier
    ├──► Purchase order tracking
    │
    ▼
Generates report:
    │
    │ Type: Weekly / Monthly / On-demand
    │
    │ Includes:
    │   • IRM cost breakdown by project
    │   • IRM cost breakdown by supplier
    │   • IRM cost breakdown by time period
    │   • Rate of purchasing trends
    │   • Based on Purchase Orders raised
    │
    │ Export: Excel / CSV
    │
    ▼
Downloads report for management / accounts / Sage
```

---

## FLOW 10B: CUSTOM REPORTING

```
PM / WH Manager / Finance Director logs in
    │
    ▼
Goes to: Reports → Custom Report
    │
    ▼
Selects filters:
    │
    ├── Date Range:  [01/05/2026] to [31/05/2026]
    ├── Item Type:   [All ▼] or [SFP-LX ▼] or [Cables ▼]
    ├── Customer:    [All ▼] or [BT ▼]
    ├── Project:     [All ▼] or [Core Migration ▼]
    ├── Warehouse:   [All ▼] or [Leeds ▼]
    ├── Report Type: [Stock Movement ▼]
    │
    ▼
[GENERATE REPORT]
    │
    ▼
Report shows filtered data:
    │
    │ Example: "BT — May 2026 — How many SFP cards dispatched?"
    │
    │ ┌──────────┬─────┬────────────┬────────────┬──────────┐
    │ │ Item     │ Qty │ Date       │ Engineer   │ Site     │
    │ ├──────────┼─────┼────────────┼────────────┼──────────┤
    │ │ SFP-LX   │ 1   │ 05/05/2026 │ Karthik    │ Leeds    │
    │ │ SFP-SX   │ 2   │ 12/05/2026 │ Suresh     │ London   │
    │ │ SFP-LX   │ 1   │ 20/05/2026 │ Karthik    │ Manchester│
    │ └──────────┴─────┴────────────┴────────────┴──────────┘
    │
    │ Total: 4 SFP cards dispatched in May 2026
    │
    ▼
Export: Excel / CSV
    │
    │ NOTE: Customer-facing reports → NO pricing / cost data shown
    │       Internal reports → Full data including costs
```

---

## FLOW 11: AUDIT TRAIL (Runs Behind Everything)

```
EVERY action in the system gets logged:
    │
    ├──► Stock scanned IN
    │       WHO: Warehouse Manager Suresh
    │       WHAT: 10x SFP-LX (serials listed)
    │       WHEN: 01/06/2026 07:15
    │       WHERE: Warehouse 1
    │       PO: PO-2026-0451
    │
    ├──► Stock dispatched OUT
    │       WHO: Engineer Karthik
    │       AUTHORIZED BY: PM Ravi
    │       WHAT: 1x SFP-LX (serial: ABC123)
    │       WHEN: 01/06/2026 08:30
    │       FOR PROJECT: BT Leeds Core Migration
    │
    ├──► Stock returned
    │       WHO: Engineer Karthik
    │       WHAT: 1x SFP-SX (serial: GHI789)
    │       CONDITION: Damaged
    │       WHEN: 02/06/2026 16:00
    │
    ├──► Engineer-to-Engineer transfer
    │       FROM: Karthik → TO: Suresh
    │       WHAT: 1x SFP-LX
    │       WHEN: 01/06/2026 14:00
    │
    ├──► Threshold changed
    │       WHO: PM Ravi
    │       WHAT: SFP-LX threshold changed from 5 to 10
    │       WHEN: 01/06/2026 09:00
    │
    ├──► Report generated
    │       WHO: Finance Director
    │       WHAT: Monthly IRM report - May 2026
    │       WHEN: 01/06/2026 10:00
    │
    └──► User login/logout
            WHO: Customer PM (BT)
            WHEN: 01/06/2026 11:00
            DEVICE: Mobile
    │
    ▼
All logs are:
    • Timestamped
    • User identified
    • Compliance ready (ISO 9001, GDPR)
    • Retained for 60 days
    • Available for audit inspection
```

---

## FLOW 12: RENTED ITEMS TRACKING

```
Company rents equipment (e.g., power tools, test equipment)
    │
    ▼
Warehouse Manager adds to system:
    │
    │ Item name
    │ Rental start date
    │ Rental end date
    │ Rental provider
    │
    ▼
Item assigned to engineer
    │
    │ System tracks: WHO has it + HOW LONG left
    │
    ▼
Rental period nearing expiry
    │
    │ System sends alert:
    │ "Power tool rental expires in 3 days — Currently with Karthik"
    │
    ▼
PM decides:
    │
    ├──► Return item → Engineer brings back, scanned in
    └──► Extend rental → Update rental period in system
```

---

## FLOW 13: NOTIFICATIONS (Runs Across All Flows)

```
TRIGGERS:
    │
    ├── Low stock threshold breached ──► PM + WH Manager
    ├── New delivery arrived ──► PM
    ├── Job assigned ──► Engineer
    ├── Job completed ──► PM
    ├── Stock dispatched ──► PM + Customer dashboard
    ├── Stock returned ──► PM + WH Manager
    ├── Rental expiry approaching ──► PM
    ├── Engineer-to-Engineer transfer ──► PM
    └── Partial delivery pending ──► PM + WH Manager

CHANNELS:
    │
    ├── In-app notification (always)
    ├── Email alert (always - if needed)
```

---

## FLOW 14: USER MANAGEMENT

```
New employee joins company
    │
    ▼
System Admin (IT Manager / HR / select PM) logs in
    │
    ▼
Creates new user account:
    │
    │ Company email
    │ Password
    │ Assign role:
    │   • Field Engineer
    │   • Project Coordinator
    │   • Project Manager
    │   • Warehouse Manager
    │   • Finance Director
    │   • HR Manager
    │   • Customer PM
    │   • System Admin
    │
    │ Assign to project(s)
    │ Assign to warehouse (if applicable)
    │
    ▼
User gets login credentials
    │
    ▼
User logs in:
    │
    │ Company email + password
    │ Max 2 devices simultaneously
    │ 
    │
    ▼
User sees role-specific dashboard
```

