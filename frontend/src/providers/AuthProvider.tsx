"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import * as authService from "@/services/auth.service";
import { clearAllClientCaches } from "@/lib/clientCache";
import { onSessionRevoked } from "@/lib/socket";
import { setSignedOutNotice } from "@/lib/signedOutNotice";
import { principalCan } from "@/lib/auth";
import type {
  AdminPrincipal,
  CustomerPrincipal,
  Principal,
  UserPrincipal,
} from "@/types/auth";

export interface AuthState {
  // The authenticated principal (admin, staff user, or customer), or null.
  principal: Principal | null;
  // Convenience accessors, each non-null only for the matching principal type.
  admin: AdminPrincipal | null;
  user: UserPrincipal | null;
  customer: CustomerPrincipal | null;
  // Permission check (admin holds everything; user checks their role permissions).
  can: (permission: string) => boolean;
  loading: boolean;
  login: (email: string, password: string, remember?: boolean) => Promise<Principal>;
  loginWithGoogle: (credential: string) => Promise<Principal>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const AuthContext = React.createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [principal, setPrincipal] = React.useState<Principal | null>(null);
  const [loading, setLoading] = React.useState(true);
  const router = useRouter();

  /**
   * Is the sign-out happening on this tab, at this user's request?
   *
   * `endSession` revokes the socket for the whole DEVICE, and a device is one session shared by every
   * tab on it — the server cannot address a single tab, because the request that logs out carries a
   * session cookie and no socket identity. So the revocation lands on the tab that pressed Log out as
   * well, while its `logout()` is still awaiting the response and this subscription is therefore
   * still live. Without this flag that tab greets the person who just signed themselves out with
   * "This device's session was ended" — copy written for a sibling tab, and alarming as an answer to
   * a button you pressed on purpose.
   *
   * A ref rather than state: it must be readable by the socket handler in the same tick it is set,
   * and it must not re-render anything. Ordering is not a race — the server cannot emit before it has
   * the request, and the flag is set before the request is sent.
   */
  const selfSignOut = React.useRef(false);

  // Re-read the current session (cookies are sent automatically).
  const refresh = React.useCallback(async () => {
    try {
      setPrincipal(await authService.getCurrentPrincipal());
    } catch {
      setPrincipal(null);
    }
  }, []);

  // Validate the session once on mount. api() silently refreshes if the access
  // token has expired, so this works even after the short access token lapses.
  React.useEffect(() => {
    let active = true;
    authService
      .getCurrentPrincipal()
      .then((me) => {
        if (active) setPrincipal(me);
      })
      .catch(() => {
        if (active) setPrincipal(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const login = React.useCallback(
    async (email: string, password: string, remember = true) => {
      const next = await authService.login(email, password, remember);
      // A new session on this tab: whatever the last sign-out was, it is over.
      selfSignOut.current = false;
      setPrincipal(next);
      return next;
    },
    [],
  );

  const loginWithGoogle = React.useCallback(async (credential: string) => {
    const next = await authService.loginWithGoogle(credential);
    selfSignOut.current = false;
    setPrincipal(next);
    return next;
  }, []);

  const logout = React.useCallback(async () => {
    // Before the request, not after: this is what the revoke handler reads when the server's push
    // comes back, and the push cannot arrive before the request that causes it.
    selfSignOut.current = true;
    try {
      await authService.logout();
    } catch {
      // ignore — we clear local state regardless
    }
    // Drop every cached list/record so the next user on this tab never sees the
    // previous user's data (most importantly their device sessions).
    clearAllClientCaches();
    setPrincipal(null);
  }, []);

  /**
   * The account is capped at ONE signed-in device, so the ordinary way to lose a session is for the
   * same person to sign in somewhere else. Without this the bumped tab keeps rendering the data it
   * already fetched and only discovers it is dead at the next request — which reads as the app
   * breaking, not as being signed out.
   *
   * The server has already deleted the session row and is about to close this socket, so there is
   * nothing to tell it: no /auth/logout call (it would 401 against the session it is reporting
   * gone). Purely local — drop the caches so the next person on this tab can't page through the
   * previous one's data, then get off the protected screen.
   */
  // Keyed on the principal's ID, not the object: refresh() and login() hand back a fresh object for
  // the same person, and depending on that would tear the subscription down and back up each time —
  // which, on a screen where this is the only socket consumer, means dropping and re-opening the
  // websocket (a handshake, a JWT verify and a session lookup) for no change at all.
  const principalId = principal?.id ?? null;

  React.useEffect(() => {
    if (!principalId) return; // signed out here — nothing to revoke, and no socket worth holding
    return onSessionRevoked((reason) => {
      // Our own Log out, echoed back at us — `logout()` is already clearing the caches and dropping
      // the principal, and AuthGuard takes it to /login. Announcing it would be untrue.
      if (selfSignOut.current) return;
      clearAllClientCaches();
      setSignedOutNotice(reason ?? "signed_out_remotely");
      setPrincipal(null);
      router.replace("/login");
    });
  }, [principalId, router]);

  const admin = principal?.type === "admin" ? principal : null;
  const user = principal?.type === "user" ? principal : null;
  const customer = principal?.type === "customer" ? principal : null;
  const can = (permission: string) => principalCan(principal, permission);

  return (
    <AuthContext.Provider
      value={{ principal, admin, user, customer, can, loading, login, loginWithGoogle, logout, refresh }}
    >
      {children}
    </AuthContext.Provider>
  );
}
