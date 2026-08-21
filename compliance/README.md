# Compliance documentation

Data-protection documentation for the Senthra platform, assessed against the **UK GDPR** and the
**Data Protection Act 2018**.

This directory is **tracked in git**, unlike `/docs`, which is gitignored — compliance records have
to survive a branch switch and be visible to everyone on the team.

| Document | What it is | Status |
|---|---|---|
| [privacy-policy.md](privacy-policy.md) | The notice given to data subjects (Art. 13/14) | **Draft — requires legal sign-off. Rendered at `/privacy` (noindex), NOT linked from the sign-in screen.** |
| [ropa.md](ropa.md) | Record of Processing Activities (Art. 30) | Factual sections complete; retention + lawful bases TBC |
| [sub-processors.md](sub-processors.md) | Third parties that receive personal data (Art. 28, Ch. V) | Recipients verified; agreements + transfer mechanisms TBC |
| [dpia-screening.md](dpia-screening.md) | Whether a DPIA is required (Art. 35) | Screening recorded; conclusion requires sign-off |
| [cookie-policy.md](cookie-policy.md) | Cookies and local storage (PECR reg. 6) | Complete and factual |
| [retention-policy.md](retention-policy.md) | How long each record is kept (Art. 5(1)(e)) | **Every period is TBC — nothing is decided** |

## How these were produced

The factual content — what personal data exists, where it goes, which third parties receive it, what
cookies are set — was derived by reading the source code and is cited to file and line so it can be
re-verified. Anything that is a **legal or business judgement** has deliberately been left as `TBC`
rather than guessed:

- lawful bases for each processing activity
- retention periods
- whether processor agreements are in place
- international transfer mechanisms
- controller identity, ICO registration status, and whether a DPO is required

Do not fill those in from this directory alone. They need business and legal confirmation.

## What is implemented in code, and what is not

Implemented:

- The staff list endpoint returns a directory-safe projection only (no date of birth, gender, home
  address, notes or phone) — `backend/src/modules/user/user.service.ts`, `DirectoryUser`.
- Expired session rows are swept — `backend/src/modules/auth/session.sweep.ts`.
- Sessions and push-device tokens are cleared when an account can no longer sign in (deleted,
  inactive, suspended) — `backend/src/modules/user/user.service.ts`, `revokeSignInArtifacts`.
- Android release builds explicitly deny cleartext HTTP — `mobile/plugins/withAndroidCleartextPolicy.js`.

Written but **deliberately not running**:

- `emailLog.repository.deleteOlderThan` / `email.service.purgeEmailLogsOlderThan`. Nothing calls
  them. They stay dormant until a retention period is agreed in [retention-policy.md](retention-policy.md).

Not implemented, and not attempted (see the GDPR audit for the full list): erasure and subject-access
tooling, authenticated delivery for uploaded files, removal of unused personal fields, replacing
temporary-password emails, multi-factor authentication, and breach monitoring.
