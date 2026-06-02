"use client";

import * as React from "react";

import { api } from "./api";

export type Admin = {
  id: string;
  email: string;
  name: string | null;
  googleEmail: string | null;
};

type AuthState = {
  admin: Admin | null;
  loading: boolean;
  login: (email: string, password: string, remember?: boolean) => Promise<void>;
  loginWithGoogle: (credential: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = React.createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [admin, setAdmin] = React.useState<Admin | null>(null);
  const [loading, setLoading] = React.useState(true);

  // Re-read the current session (cookies are sent automatically).
  const refresh = React.useCallback(async () => {
    try {
      const { admin: me } = await api<{ admin: Admin }>("/auth/me");
      setAdmin(me);
    } catch {
      setAdmin(null);
    }
  }, []);

  // Validate the session once on mount. api() silently refreshes if the access
  // token has expired, so this works even after the short access token lapses.
  React.useEffect(() => {
    let active = true;
    api<{ admin: Admin }>("/auth/me")
      .then((d) => {
        if (active) setAdmin(d.admin);
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
      const { admin: me } = await api<{ admin: Admin }>("/auth/login", {
        method: "POST",
        body: { email, password, remember },
      });
      setAdmin(me);
    },
    [],
  );

  const loginWithGoogle = React.useCallback(async (credential: string) => {
    const { admin: me } = await api<{ admin: Admin }>("/auth/google", {
      method: "POST",
      body: { credential },
    });
    setAdmin(me);
  }, []);

  const logout = React.useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
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

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
