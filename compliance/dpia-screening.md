# DPIA screening record (Art. 35 UK GDPR)

> **Status.** The screening is recorded below against the ICO's criteria and is based on what the code
> demonstrably does. The **conclusion requires sign-off** — a screening decision is only useful if
> someone accountable has adopted it.

Article 35 requires a Data Protection Impact Assessment where processing is "likely to result in a
high risk to the rights and freedoms of natural persons". Recording the screening is required
regardless of the outcome, so that a negative decision is evidenced rather than merely assumed.

## Screening against the Art. 35(3) triggers

| Trigger | Present? | Evidence |
|---|---|---|
| Systematic and extensive automated evaluation, profiling, or automated decisions with legal/significant effect | **No** | No profiling, scoring or automated decision-making anywhere. Job assignment, approvals and stock movements are all initiated by a person. |
| Large-scale processing of special category or criminal-offence data (Art. 9/10) | **No, by design** | No special-category field exists. See the caveat below on `User.notes`. |
| Systematic monitoring of a publicly accessible area on a large scale | **No** | No CCTV, no public-space monitoring. |

## Screening against the ICO's additional high-risk criteria

| Criterion | Present? | Evidence |
|---|---|---|
| Tracking an individual's location or behaviour | **No** | The engineer app requests **no** location permission and contains no geolocation code (`mobile/app.json`, `mobile/src`). Job coordinates are derived server-side from a site postcode, not from a device. |
| Data concerning vulnerable subjects, including the employer/employee imbalance | **Partly** | Staff records are employee data, where consent is not freely given and the power imbalance is real. This affects the choice of lawful basis rather than triggering a DPIA on its own. |
| Innovative technology | **No** | Conventional web and mobile stack. |
| Denial of a service or contract | **No** | The system does not gate access to any service for a data subject. |
| Combining or matching datasets from different sources | **No** | All data originates in the application. |
| Data processed without the individual's knowledge | **Partly** | Supplier and job-planner contacts are entered by staff and are not notified. This is an Art. 14 transparency duty — see [privacy-policy.md](privacy-policy.md) — not a DPIA trigger. |
| Biometric or genetic data | **No** | A handwritten signature image is held, and it is **not** biometric data under Art. 4(14): it is not the product of specific technical processing for the purpose of uniquely identifying someone. It is still personal data and is treated as sensitive in the audit. |

## Provisional conclusion

On the evidence above, the processing does **not** meet the threshold for a mandatory DPIA. The
absence of location tracking, profiling, automated decision-making and special-category data are the
determining factors.

**This conclusion requires sign-off.**

| Field | Value |
|---|---|
| Screening carried out | 2026-08-21 (static review of branch `feat/rentals-hire-module`) |
| Screening carried out by | Engineering |
| Reviewed and adopted by | **TBC** |
| Date adopted | **TBC** |

## Caveats that qualify the conclusion

**`User.notes`.** An unconstrained free-text field on a personnel record, returned to every account
holding `users.view`. Nothing prevents sickness, disciplinary or health information being written
there. That would introduce Art. 9 data through the back door and would change this screening. Not
remediated (GDPR audit, F-09).

**Date of birth and gender** are collected on every staff record but are read by no business logic.
Their presence is a minimisation question rather than a DPIA trigger. Not remediated (F-10).

## What would reverse this conclusion

Re-run this screening — and expect a DPIA to be required — if any of the following is proposed:

1. **Engineer location tracking**, live or historical. This is the single most likely change, it is a
   natural feature request for a field-operations product, and it would constitute systematic
   monitoring of workers.
2. Automated performance measurement or scoring of engineers.
3. Recording health, absence or disciplinary information as structured data.
4. Biometric authentication.
5. Sharing personal data with a customer or third party beyond what the portal exposes today.
6. A significant increase in scale or in the categories of subject.
