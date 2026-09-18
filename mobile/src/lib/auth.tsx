import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, hydrateToken, setAccessToken } from "./api";
import type { Principal } from "../types";

/**
 * A pending email two-factor challenge, exactly as the server describes it.
 *
 * `email` arrives already masked, and the two counters are DURATIONS rather than instants — see
 * twoFactorCountdown.ts for why that matters on a device whose clock may be wrong.
 */
export interface TwoFactorPending {
  twoFactorRequired: true;
  email: string;
  expiresInSeconds: number;
  resendInSeconds: number;
  resendsRemaining: number;
}

/**
 * What a sign-in attempt produced: a session, or a challenge standing between the two.
 *
 * A discriminated union rather than an optional token, because the 202 case is not a degraded
 * success: THE CALLER MUST BRANCH. Before this existed the app read `res.token` off a 202 body that
 * has none, wrote `undefined` over the stored token, and handed `undefined` to a screen that read
 * `principal.type` — an engineer saw "Welcome," and then a raw TypeError, with no session and no way
 * forward. With 2FA switched on that was every engineer, every attempt.
 */
export type LoginResult =
  | { twoFactorRequired: false; principal: Principal }
  | TwoFactorPending;

interface AuthState {
  principal: Principal | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  /** The challenge this session is waiting on, if sign-in stopped at one. */
  pendingTwoFactor: TwoFactorPending | null;
  /** `Date.now()` when `pendingTwoFactor` arrived — the anchor its countdowns are measured from. */
  pendingTwoFactorAt: number;
  /** Trade the emailed code for a session. */
  verifyTwoFactor: (code: string) => Promise<Principal>;
  /** Ask for a fresh code on the SAME challenge. */
  resendTwoFactor: () => Promise<TwoFactorPending>;
  /** Abandon the challenge and return to the credential form. */
  cancelTwoFactor: () => Promise<void>;
  logout: () => Promise<void>;
  refreshPrincipal: () => Promise<Principal | null>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function principalName(p: Principal | null): string {
  if (!p) return "";
  if (p.type === "user") return `${p.firstName} ${p.lastName}`.trim() || p.email;
  if (p.type === "admin") return p.name ?? p.email;
  return p.fullName ?? p.email;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * The pending challenge and the instant it arrived, kept together so they can never be set apart:
   * the countdowns are only meaningful measured from the moment that description landed.
   */
  const [twoFactor, setTwoFactor] = useState<{ pending: TwoFactorPending; at: number } | null>(null);

  const adoptChallenge = useCallback(
    (pending: TwoFactorPending) => setTwoFactor({ pending, at: Date.now() }),
    [],
  );

  const refreshPrincipal = useCallback(async (): Promise<Principal | null> => {
    try {
      const res = await api<{ principal: Principal }>("/auth/me");
      setPrincipal(res.principal);
      return res.principal;
    } catch {
      setPrincipal(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await hydrateToken();
      // Even without a stored token the native cookie jar may still hold a live session.
      const p = token !== undefined ? await refreshPrincipal() : null;

      // NO SESSION, but there may be a half-finished sign-in. This is the ordinary case on a phone,
      // not an edge one: the engineer taps Verify, leaves for the Mail app to read the code, and the
      // OS reclaims the app while it is in the background. Without this probe they come back to the
      // credential form holding a code that is still perfectly good, and the only way on is to ask
      // for another one. The challenge cookie is httpOnly and scoped to /auth/2fa, so asking the
      // server is the only way to find out. A 401 — no challenge — is the normal answer and is why
      // the failure is swallowed rather than surfaced.
      if (!p && !cancelled) {
        try {
          adoptChallenge(await api<TwoFactorPending>("/auth/2fa/challenge"));
        } catch {
          // nothing pending
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshPrincipal, adoptChallenge]);

  /**
   * Adopt a session the server just granted. Shared by password login and 2FA verification, which
   * answer with the SAME body — the code step is simply where that body arrives when 2FA is on.
   */
  const adoptSession = useCallback(async (res: { token: string; principal: Principal }) => {
    await setAccessToken(res.token);
    setPrincipal(res.principal);
    setTwoFactor(null);
    return res.principal;
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      // 200 carries a session; 202 carries a challenge and NO token. Both are `res.ok`, so the
      // discriminator is the body, not the status — and it must be read before anything touches
      // `token`.
      const res = await api<Partial<TwoFactorPending> & { token?: string; principal?: Principal }>(
        "/auth/login",
        { method: "POST", body: { email: email.trim().toLowerCase(), password, remember: true } },
      );

      if (res.twoFactorRequired) {
        const pending: TwoFactorPending = {
          twoFactorRequired: true,
          email: res.email ?? "",
          expiresInSeconds: res.expiresInSeconds ?? 0,
          resendInSeconds: res.resendInSeconds ?? 0,
          resendsRemaining: res.resendsRemaining ?? 0,
        };
        adoptChallenge(pending);
        return pending;
      }

      const principal = await adoptSession({ token: res.token!, principal: res.principal! });
      return { twoFactorRequired: false, principal };
    },
    [adoptSession, adoptChallenge],
  );

  const verifyTwoFactor = useCallback(
    async (code: string): Promise<Principal> => {
      const res = await api<{ token: string; principal: Principal }>("/auth/2fa/verify", {
        method: "POST",
        body: { code: code.trim() },
      });
      return adoptSession(res);
    },
    [adoptSession],
  );

  const resendTwoFactor = useCallback(async (): Promise<TwoFactorPending> => {
    const pending = await api<TwoFactorPending>("/auth/2fa/resend", { method: "POST" });
    adoptChallenge(pending);
    return pending;
  }, [adoptChallenge]);

  const cancelTwoFactor = useCallback(async (): Promise<void> => {
    // Best-effort: the user is NOT authenticated, so a network failure must never trap them on the
    // code step. An abandoned challenge expires on its own, and the next sign-in supersedes it.
    try {
      await api("/auth/2fa/cancel", { method: "POST" });
    } catch {
      // ignored on purpose — see above
    }
    setTwoFactor(null);
  }, []);

  const logout = useCallback(async () => {
    // Drop this device's push token while still authenticated, so a signed-out
    // phone stops receiving notifications. Dynamically imported so no push /
    // notification code is pulled into the root graph (keeps Expo Go inert).
    try {
      const push = await import("./push");
      await push.unregisterForPush();
    } catch {
      // push module unavailable (e.g. Expo Go) — nothing to unregister
    }
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      // Best-effort — clear local state regardless.
    }
    await setAccessToken(null);
    setPrincipal(null);
  }, []);

  const can = useCallback(
    (permission: string): boolean => {
      if (!principal) return false;
      if (principal.type === "admin") return true;
      const perms = principal.permissions ?? [];
      return perms.includes("*") || perms.includes(permission);
    },
    [principal],
  );

  return (
    <AuthContext.Provider
      value={{
        principal,
        loading,
        login,
        pendingTwoFactor: twoFactor?.pending ?? null,
        pendingTwoFactorAt: twoFactor?.at ?? 0,
        verifyTwoFactor,
        resendTwoFactor,
        cancelTwoFactor,
        logout,
        refreshPrincipal,
        can,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
