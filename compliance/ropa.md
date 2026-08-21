# Record of Processing Activities (Art. 30 UK GDPR)

> **Status.** The inventory below is factual and derived from the source code. Every **lawful basis**
> and **retention period** is `TBC` and requires business/legal confirmation — see
> [retention-policy.md](retention-policy.md). Do not publish or rely on this record until those are
> filled in.

## 1. Controller

| Field | Value |
|---|---|
| Controller name and registered address | **TBC — requires business confirmation** |
| ICO registration number / fee status | **TBC — requires business confirmation** |
| Data Protection Officer | **TBC — requires assessment of whether Art. 37 obliges one** |
| Contact point for data subjects | **TBC** |

## 2. Categories of data subject

| Subject | How they enter the system | Can they log in? |
|---|---|---|
| Staff (office, warehouse, field engineers) | Created by an administrator | Yes — web dashboard and Android app |
| Customer contacts | Created by staff, invited to the portal | Yes — customer portal (read-only) |
| Supplier contacts | Entered by staff as part of a supplier record | No |
| Job planner contacts | Copied from a customer's job pack onto a job | No |

## 3. Personal data held

Verified against `backend/prisma/schema.prisma`.

| Model | Personal data | Notes |
|---|---|---|
| `User` | First/last name, email, phone, home address (2 lines, city, postcode), date of birth, gender, employee ID, job title, department, joining date, profile photo, handwritten signature image, free-text notes, password hash, reset-token hash | The most sensitive record in the system |
| `CustomerUser` | Full name, email, phone, designation, password hash, reset-token hash, last login | Portal login identity |
| `Customer` | Primary contact name and job title, email, phone, alternate phone, company address | Company record carrying a named contact |
| `Supplier` | Contact name, email, phone, address | |
| `Job` | Assigned engineer name + email (snapshots), accepting/rejecting engineer email, planner name and phone, site address and coordinates | Snapshots are copies that survive changes to the source record |
| `Session` | IP address, user-agent, principal id, timestamps | One row per signed-in device |
| `AuditLog` | Actor id and email (snapshot), target label (frequently an email address) | |
| `EmailLog` | Recipient address, subject, delivery status, error text | Write-only: no application code reads it back |
| `DeviceToken` | FCM registration token, user id, platform | Android push |
| `UserWarehouseAssignment` | Assigning staff member's email | |
| Cloudinary (external) | Profile photos, handwritten signatures, damage photographs, site/job-pack documents, issued purchase-order PDFs | See [sub-processors.md](sub-processors.md) |

**Special category data (Art. 9):** none is collected by design. `User.notes` is unconstrained free
text on a personnel record and could receive it in practice — see the GDPR audit, F-09. Not remediated.

**Children's data:** none. Validation requires a staff member to be at least 16 at their joining date
(`backend/src/modules/user/user.validation.ts`).

## 4. Purposes of processing

| # | Activity | Data used | Lawful basis |
|---|---|---|---|
| 1 | Staff account administration and access control | `User`, `Role`, `UserWarehouseAssignment` | **TBC** |
| 2 | Authentication and session management | `User`, `CustomerUser`, `Session` | **TBC** |
| 3 | Field job assignment and completion | `Job`, `User` (engineer), `CustomerSite` | **TBC** |
| 4 | Stock custody and reconciliation per engineer | `EngineerStockBalance`, `EngineerStockTransaction` | **TBC** |
| 5 | Procurement (purchase requests and orders, supplier correspondence) | `Supplier`, `User` (signatory) | **TBC** |
| 6 | Customer portal — customers viewing their own jobs and stock | `Customer`, `CustomerUser`, `Job` | **TBC** |
| 7 | Transactional email (invitations, resets, assignment and deadline notices) | `EmailLog`, recipient addresses | **TBC** |
| 8 | Push notification to engineer devices | `DeviceToken` | **TBC** |
| 9 | Audit logging of administrative and operational actions | `AuditLog` | **TBC** |
| 10 | Document generation (purchase-order PDFs carrying a signatory's name, title and signature) | `User` | **TBC** |

There is **no** marketing, profiling, automated decision-making, or behavioural tracking. No analytics
or advertising script is present in any client (verified across `frontend/src` and `mobile/src`).

## 5. Recipients

See [sub-processors.md](sub-processors.md). In summary: Cloudinary (media and documents), Google
Firebase Cloud Messaging (push), postcodes.io (postcode lookup — postcode only, no identifier), the
configured SMTP provider, the MongoDB host, and the application host.

## 6. International transfers

**TBC.** Recipients are identified in [sub-processors.md](sub-processors.md); several are US-based.
No transfer mechanism (UK IDTA or the UK Addendum to the EU SCCs) is currently recorded for any of
them, and whether one exists has not been confirmed.

## 7. Retention

**TBC for every category.** See [retention-policy.md](retention-policy.md). What is implemented today:

- Sessions carry a 7-day expiry and expired rows are now swept.
- Sessions and device tokens are cleared when an account can no longer sign in.
- Everything else — audit entries, email delivery logs, soft-deleted staff and customer records,
  stock ledgers, uploaded files — is kept indefinitely.

## 8. Technical and organisational measures (Art. 32)

Verified in code:

- Passwords hashed with bcrypt, cost factor 12 (`backend/src/utils/password.ts`).
- Password-reset tokens stored only as SHA-256 hashes with an expiry.
- SMTP password and Google client secret encrypted at rest with AES-256-GCM (`backend/src/utils/crypto.ts`).
- Authentication cookies are httpOnly, `Secure` in production, `SameSite` set; the refresh cookie is
  scoped to its own path (`backend/src/utils/cookies.ts`).
- Server-side session revocation on every request; a maximum of two concurrent devices per account.
- Rate limiting on login, refresh, forgot-password, reset, password change, exports and writes.
- `helmet` security headers; CORS restricted to one configured origin.
- Server errors never return internal detail to the client (`backend/src/middleware/error.middleware.ts`).
- Granular role-based permissions with per-warehouse scoping.
- Android release builds deny cleartext HTTP (`mobile/plugins/withAndroidCleartextPolicy.js`).

Known gaps, not remediated — see the GDPR audit: no multi-factor authentication; no breach detection,
alerting or log aggregation; uploaded files are served from public CDN URLs; no erasure mechanism.

Not determinable from the code, and **TBC**: database hosting region, encryption at rest, backup
existence and retention, and whether erasure would reach backups.

## 9. Review

| Field | Value |
|---|---|
| Record created | 2026-08-21 |
| Basis | Static review of branch `feat/rentals-hire-module` |
| Next review due | **TBC — set a review cadence** |
