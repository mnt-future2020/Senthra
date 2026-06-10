// Client-side validation primitives (UK-aware) shared by the user + customer forms.
// They give instant, field-level feedback before the request; the backend stays the
// source of truth (defence in depth).

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Standard UK postcode shape, e.g. "EC1A 1BB", "M1 1AE", "GU16 7HF".
export const UK_POSTCODE_RE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/;

// UK phone only: national "0" + 9–10 digits (e.g. 07700 900000) or international
// "+44" with an optional "(0)" + 9–10 digits, after stripping spaces/hyphens/parens.
export const UK_PHONE_RE = /^(?:\+440?|0)\d{9,10}$/;

// Lenient website: empty, a bare domain, or a full http/https URL.
export const WEBSITE_RE = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+([/?#].*)?$/i;

// Normalize then test a UK phone number (tolerates spaces, hyphens and parens).
export const isPhone = (v: string): boolean => UK_PHONE_RE.test(v.replace(/[\s()-]/g, ""));
