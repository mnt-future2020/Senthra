# Retention policy

> **Status: NOT DECIDED.** Every period below is `TBC`. Nothing in this document has been agreed, and
> no period has been invented to fill a gap. Until each row is confirmed by the business — with legal
> input where a statutory minimum applies — the deletion routines that would enforce them stay
> switched off.

## Why the periods are blank

A retention period is a business and legal decision, not an engineering default. Employment records
carry statutory minimums; financial documents carry others; audit evidence has to outlive the
incidents it would be used to investigate. Guessing a number here would create a policy nobody agreed
to and would quietly delete data someone is obliged to keep.

A previous claim that logs were **"Retained for 60 days"** appeared in the business flow
documentation. It was never implemented anywhere in the codebase and has been removed rather than
restated — see the note at the end of this document.

## Retention schedule

| # | Record | Personal data | Retained today | Agreed period | Enforcement |
|---|---|---|---|---|---|
| 1 | `Session` | IP address, user-agent | 7 days, now swept | **Implemented** — the row's own `expiresAt` | `backend/src/modules/auth/session.sweep.ts` |
| 2 | `DeviceToken` — account can no longer sign in | FCM token, user id | Cleared on delete / inactive / suspended | **Implemented** — event-driven, no period | `revokeSignInArtifacts` in `user.service.ts` |
| 3 | `DeviceToken` — stale but still valid account | FCM token, user id | Indefinite | **TBC** | Not implemented |
| 4 | `EmailLog` | Recipient address, subject, error text | Indefinite | **TBC** | Written but **dormant** — see below |
| 5 | `AuditLog` | Actor email, target label | Indefinite | **TBC** | Not implemented — deliberately out of scope |
| 6 | `User` — soft-deleted | Full personnel record | Indefinite | **TBC** | Not implemented (needs erasure design first) |
| 7 | `Customer` / `CustomerUser` — soft-deleted | Contact details | Indefinite | **TBC** | Not implemented |
| 8 | `Job` — soft-deleted | Engineer name/email snapshots, planner contact, site address | Indefinite | **TBC** | Not implemented |
| 9 | Cloudinary assets | Photographs, signatures, documents | Indefinite | **TBC** | Not implemented |
| 10 | Database backups | Everything | Unknown | **TBC** | Outside the application |

## Rows 1 and 2 — what was implemented, and why it needed no decision

Neither introduces a period.

**Sessions.** A session row is created with `expiresAt` set from the existing seven-day
`SESSION_TTL_MS`. From that moment the application already refuses it: `findActive` rejects an elapsed
row, `listSessions` filters it out of the device list, and `startSession` excludes it from the
two-device cap. The sweep deletes rows the application already declines to honour, so it changes no
behaviour — it only stops a dead row, and the IP address on it, outliving the session because nobody
happened to present its id again. The previous pruning was lazy and only ever triggered by someone
returning.

**Device tokens.** Cleared when an account is deleted, deactivated or suspended. All three states fail
`requireAuth`, so no token belonging to an account that can still sign in is ever removed. Reinstating
a user is safe: the Android app re-registers on every signed-in launch, not only at login
(`mobile/src/lib/usePushNotifications.ts`).

Row 3 — tokens belonging to accounts that *can* still sign in — is a genuine retention question and is
left `TBC`.

## Row 4 — the EmailLog purge is written but dormant

`emailLog.repository.deleteOlderThan(cutoff)` and `email.service.purgeEmailLogsOlderThan(cutoff)`
exist and are tested. **Nothing calls them.** There is no timer, route or start-up hook, and
`emailLog.retention.test.ts` fails if one appears.

`cutoff` is a required argument with no default, so the function cannot be invoked with a period
nobody agreed to. A default value here would silently *become* the policy.

The model is safe to purge once a period is set: `EmailLog` is write-only. `create` is called on the
send path; `findRecent` and `countByStatus` have no callers anywhere in the application. Deleting old
rows removes stored recipient addresses without affecting sending, templating, delivery-status
recording or retry behaviour.

## What is needed to finish this

1. A period for each `TBC` row, with the reason (statutory minimum, contractual need, or operational).
2. Confirmation of any statutory minimum that overrides a shorter preference — employment records and
   financial documents in particular.
3. A decision on whether deletion means erasure or pseudonymisation for rows 6–8, since names are
   snapshotted onto historical jobs and audit entries deliberately (see the GDPR audit, F-01).
4. A decision on whether backups are in scope for deletion, and what that implies operationally.
5. Only then: enable the EmailLog purge and build the remaining routines.

## Note on the removed claim

`docs/Senthra_Complete_Business_Flow.md` previously stated that logs are "Retained for 60 days" and
that the system is "Compliance ready (ISO 9001, GDPR)". Neither was implemented and neither could be
evidenced, so both have been removed rather than replaced with another unsupported claim. That file is
gitignored, so the edit is local — see the note in [README.md](README.md) and re-apply it wherever
that documentation is actually published.
