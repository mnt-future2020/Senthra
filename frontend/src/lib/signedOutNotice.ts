// A one-shot message handed from "you were signed out" to the login screen.
//
// The sign-out is decided in AuthProvider (a socket push from the server) but has to be EXPLAINED
// on /login, which is a different screen mounted after the redirect. sessionStorage carries it
// across that hop.
//
// Why not a `?signedOut=` query param: reading one needs useSearchParams, which opts the login
// route out of static rendering unless it is wrapped in Suspense — a build-shaped cost for a string
// that is read once and thrown away. sessionStorage is also per-TAB, which is what we want: the tab
// that got bumped explains itself; a second tab opened later shows a clean login form.

const KEY = "senthra:signed-out-reason";

/**
 * Split into a headline and a supporting line rather than one long sentence.
 *
 * The banner sits directly above the email field, so what matters is that the WHAT ("Signed out on
 * this device") is readable at a glance and the WHY sits underneath for whoever wants it. Rolled
 * into a single paragraph it wraps to three dense lines that a person mid-login just skips.
 */
export interface SignedOutNotice {
  title: string;
  body: string;
}

// Kept as data rather than inline JSX so the copy lives in one place and an unrecognised value from
// a future server version degrades to the generic line instead of rendering a raw enum at the user.
const MESSAGES: Record<string, SignedOutNotice> = {
  signed_in_elsewhere: {
    title: "Signed out on this device",
    body: "Your account just signed in somewhere else. Only one device can be signed in at a time.",
  },
  signed_out_remotely: {
    title: "Signed out",
    body: "This device's session was ended. Sign in again to continue.",
  },
};

const FALLBACK: SignedOutNotice = {
  title: "Signed out",
  body: "Sign in again to continue.",
};

/** Remember why this tab is being sent to /login. Safe to call anywhere — storage can throw. */
export function setSignedOutNotice(reason: string): void {
  try {
    sessionStorage.setItem(KEY, reason);
  } catch {
    // Private mode / storage disabled — the user still gets bounced to /login, just without the
    // explanation. Never let a storage failure block the sign-out itself.
  }
}

/**
 * Read the notice and consume it, so a refresh of /login (or navigating back to it later) doesn't
 * keep re-accusing the user of something that happened once. Returns null when there is nothing to
 * say — the ordinary case of somebody simply opening the login page.
 */
export function takeSignedOutNotice(): SignedOutNotice | null {
  try {
    const reason = sessionStorage.getItem(KEY);
    if (!reason) return null;
    sessionStorage.removeItem(KEY);
    return MESSAGES[reason] ?? FALLBACK;
  } catch {
    return null;
  }
}
