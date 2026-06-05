"use client";

import * as React from "react";

import * as authService from "@/services/auth.service";
import {
  principalCan,
  type AdminPrincipal,
  type Principal,
  type UserPrincipal,
} from "@/types/auth";

export interface AuthState {
  // The authenticated principal (admin or staff user), or null.
  principal: Principal | null;
  // Convenience accessors, each non-null only for the matching principal type.
  admin: AdminPrincipal | null;
  user: UserPrincipal | null;
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
      setPrincipal(next);
      return next;
    },
    [],
  );

  const loginWithGoogle = React.useCallback(async (credential: string) => {
    const next = await authService.loginWithGoogle(credential);
    setPrincipal(next);
    return next;
  }, []);

  const logout = React.useCallback(async () => {
    try {
      await authService.logout();
    } catch {
      // ignore — we clear local state regardless
    }
    setPrincipal(null);
  }, []);

  const admin = principal?.type === "admin" ? principal : null;
  const user = principal?.type === "user" ? principal : null;
  const can = (permission: string) => principalCan(principal, permission);

  return (
    <AuthContext.Provider
      value={{ principal, admin, user, can, loading, login, loginWithGoogle, logout, refresh }}
    >
      {children}
    </AuthContext.Provider>
  );
}
