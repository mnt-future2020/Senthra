# Cookies and local storage

> **Status.** Factual and complete — every entry below was verified in the source. The only open item
> is the wording that gets published to users, which belongs in
> [privacy-policy.md](privacy-policy.md).

## Summary

The application sets **three cookies** and uses a small amount of local storage. There are **no
analytics, advertising, or tracking cookies**, and no third-party script that could set one — verified
by searching `frontend/src` and `mobile/src` for every common vendor (Google Analytics, Google Tag
Manager, Hotjar, Segment, Mixpanel, PostHog, Sentry, Meta, Clarity): none is present, and none appears
in `frontend/package.json`.

Consequently the consent-banner obligation that applies to most web applications does not arise here.
The cookies below need to be **described** in the privacy notice; on the current analysis they do not
need a consent gate. Confirm that reading before publication.

## Cookies

| Name | Purpose | Set by | Attributes | Lifetime | Classification |
|---|---|---|---|---|---|
| Access token | Carries the authenticated session on every API call | Server, on login/refresh | `httpOnly`, `Secure` in production, `SameSite=None` in production / `Lax` in development | 15 minutes (`ACCESS_TOKEN_EXPIRY`) | Strictly necessary |
| Refresh token | Obtains a new access token without re-entering credentials | Server, on login/refresh | Same, plus scoped to the refresh path only | 7 days (`REFRESH_TOKEN_EXPIRY`) | Strictly necessary |
| Appearance | Remembers theme, accent colour, density and corner radius, and applies them during server rendering to avoid a flash of the wrong theme | Browser, when the user changes a setting | `SameSite=Lax`, `path=/` — not `httpOnly` (the client must read it) | `APPEARANCE_MAX_AGE` | Preference, set by explicit user action |

Sources: `backend/src/utils/cookies.ts`, `frontend/src/lib/appearance.ts:62`,
`backend/src/config/env.ts`.

## Local storage

| Key pattern | Purpose | Personal data? |
|---|---|---|
| `<key>:collapsed` | Whether a collapsible panel is open or closed | No — a boolean per panel |

Source: `frontend/src/hooks/usePersistedCollapse.ts`. The code tolerates local storage being blocked
(private mode, group policy) and simply leaves panels expanded.

## Mobile app

The Android app stores the access token in **`expo-secure-store`**, which is backed by the Android
Keystore — not in a cookie or in plain local storage (`mobile/src/lib/api.ts`). Session cookies issued
by the API are also handled by the platform's native networking stack.

## Analysis

The two authentication cookies are necessary to provide a service the user has explicitly requested —
signing in — and fall within the PECR reg. 6(4) exemption.

The appearance cookie stores a presentation preference, is written only as the direct result of the
user changing that setting, contains no identifier, and is never transmitted to a third party. On the
current analysis it falls within the same exemption. **Confirm this reading before publication** — it
is a judgement, not a fact, and it is the one item on this page that is not purely verifiable from
code.

## What is needed to finish this

1. Confirm the exemption analysis for the appearance cookie.
2. Fold the table above into the published privacy notice.
3. Re-check this page whenever a third-party script or SDK is added to any client — that is the change
   that would create a consent obligation where none exists today.
