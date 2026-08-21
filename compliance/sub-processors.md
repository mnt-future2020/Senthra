# Sub-processors and recipients

> **Status.** The recipients and the data they receive are **verified from the source code** and cited
> below. Whether an Art. 28 processor agreement exists, and what transfer mechanism covers each one,
> is **TBC** — none has been confirmed, and none is assumed here.

## Recipients

| # | Recipient | What it receives | Where it is used | Agreement | Transfer mechanism |
|---|---|---|---|---|---|
| 1 | **Cloudinary** | Profile photographs, handwritten signature images, damage photographs, job-pack documents, issued purchase-order PDFs | `backend/src/lib/cloudinary.ts`; upload contracts in `backend/src/modules/upload/upload.catalog.ts` | **TBC** | **TBC** |
| 2 | **Google — Firebase Cloud Messaging** | Device registration tokens and notification payloads (job/stock notification titles and bodies) | `backend/src/lib/push.ts`; configured via `FIREBASE_*` in `backend/src/config/env.ts` | **TBC** | **TBC** |
| 3 | **postcodes.io** | A UK postcode only. No name, identifier or other field is sent, and no response is stored against a person beyond the coordinates on a job or site | `backend/src/lib/geocode.ts:9` | **TBC** | UK-based service — assess whether a transfer arises at all |
| 4 | **SMTP provider** (identity set at runtime) | Recipient email address and the full message body, including one-time temporary passwords | `backend/src/lib/mailer.ts`; credentials stored encrypted in `Settings` | **TBC** | **TBC** |
| 5 | **Database host** (MongoDB) | Every record in [ropa.md](ropa.md) §3 | `DATABASE_URL` | **TBC** | **TBC** |
| 6 | **Application host** | All traffic in transit; server logs | Deployment configuration | **TBC** | **TBC** |

## Notes on specific recipients

**Cloudinary.** Assets are uploaded with the default delivery type, which is public — anyone holding
the URL can fetch the file without authenticating. Handwritten signatures additionally use a
deterministic public id, `senthra/signatures/signature-<userId>`
(`backend/src/modules/user/user.service.ts:289`). This is recorded here because it affects what the
processor is holding and how reachable it is. It is **not remediated** (GDPR audit, F-02).

**SMTP provider.** Account-creation and invite-resend emails carry a working temporary password in
the message body (`backend/src/modules/email/emailTemplate.defaults.ts`). The provider — and every
mailbox and archive downstream of it — therefore holds a live credential until first login. Not
remediated (GDPR audit, F-13).

**postcodes.io.** The narrowest recipient in the list. Only the postcode string is transmitted, so no
individual is identifiable from the request itself.

**Database and application hosts.** Named as roles rather than vendors because the deployment target
is not determinable from the repository. Confirm both, along with region and encryption-at-rest, before
this document is treated as complete.

## What is required before this is finished

1. Name the actual vendor entity for rows 4, 5 and 6.
2. Obtain and file an Art. 28 processor agreement for each recipient.
3. Determine which recipients involve a restricted transfer and record the mechanism — UK IDTA or the
   UK Addendum to the EU SCCs — together with any transfer risk assessment.
4. Record each vendor's own sub-processor list and how changes to it are notified.
5. Decide whether row 3 constitutes a transfer at all.

None of the above may be inferred from this document. Each needs confirmation.
