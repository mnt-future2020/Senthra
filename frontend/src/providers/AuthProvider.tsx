"use client";

import * as React from "react";

import * as authService from "@/services/auth.service";
import type { Admin } from "@/types/auth";

export interface AuthState {
  admin: Admin | null;
  loading: boolean;
  login: (email: string, password: string, remember?: boolean) => Promise<void>;
  loginWithGoogle: (credential: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const AuthContext = React.createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [admin, setAdmin] = React.useState<Admin | null>(null);
  const [loading, setLoading] = React.useState(true);

  // Re-read the current session (cookies are sent automatically).
  const refresh = React.useCallback(async () => {
    try {
      setAdmin(await authService.getCurrentAdmin());
    } catch {
      setAdmin(null);
    }
  }, []);

  // Validate the session once on mount. api() silently refreshes if the access
  // token has expired, so this works even after the short access token lapses.
  React.useEffect(() => {
    let active = true;
    authService
      .getCurrentAdmin()
      .then((me) => {
        if (active) setAdmin(me);
      })
      .catch(() => {
        if (active) setAdmin(null);
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
      setAdmin(await authService.login(email, password, remember));
    },
    [],
  );

  const loginWithGoogle = React.useCallback(async (credential: string) => {
    setAdmin(await authService.loginWithGoogle(credential));
  }, []);

  const logout = React.useCallback(async () => {
    try {
      await authService.logout();
    } catch {
      // ignore — we clear local state regardless
    }
    setAdmin(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ admin, loading, login, loginWithGoogle, logout, refresh }}
    >
      {children}
    </AuthContext.Provider>
  );
}
