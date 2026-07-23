import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, hydrateToken, setAccessToken } from "./api";
import type { Principal } from "../types";

interface AuthState {
  principal: Principal | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<Principal>;
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
      if (token !== undefined) await refreshPrincipal();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshPrincipal]);

  const login = useCallback(async (email: string, password: string): Promise<Principal> => {
    const res = await api<{ token: string; principal: Principal }>("/auth/login", {
      method: "POST",
      body: { email: email.trim().toLowerCase(), password, remember: true },
    });
    await setAccessToken(res.token);
    setPrincipal(res.principal);
    return res.principal;
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
    <AuthContext.Provider value={{ principal, loading, login, logout, refreshPrincipal, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
