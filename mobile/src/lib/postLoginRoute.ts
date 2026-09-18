import type { Principal } from "../types";

/**
 * Where a freshly signed-in principal belongs.
 *
 * Shared because sign-in finishes in TWO places — the credential screen and the two-factor code
 * screen — and a rule written twice is a rule that gets changed once.
 *
 * Its own module rather than a function inside auth.tsx, for the same reason every other rule in
 * this folder is: auth.tsx reaches SecureStore and therefore react-native, so anything living there
 * cannot be unit-tested. Filed here, the routing decision is pinned by a test instead of by
 * remembering to check both screens.
 */
export function postLoginRoute(p: Principal): "/set-password" | "/overview" {
  return p.type === "user" && p.mustResetPassword ? "/set-password" : "/overview";
}
