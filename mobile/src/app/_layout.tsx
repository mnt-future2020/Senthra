import React from "react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ToastProvider } from "@/lib/toast";
import { colors } from "@/lib/theme";

// Hold the native splash until the branded animated splash (app/index.tsx)
// is on screen, so startup is one continuous splash with no white flash.
void SplashScreen.preventAutoHideAsync().catch(() => {
  /* already prevented or unavailable — harmless */
});

// Status bar style is driven per screen via the stack's statusBarStyle options
// (dark by default, light over the purple tab header) — no global <StatusBar>.
export default function RootLayout() {
  return (
    <AuthProvider>
      <ToastProvider>
        <RootStack />
      </ToastProvider>
    </AuthProvider>
  );
}

// Split out so it can read the session — the provider is mounted above it.
function RootStack() {
  const { principal, loading, can } = useAuth();

  // The detail/action screens below are siblings of `(tabs)`, so the gate inside the tab layout
  // does NOT cover them: a push notification deep-links straight to `jobs/[id]`, `transfers/[id]`
  // or `van-stock/[id]` (see lib/push.ts routeFromNotification), landing a user with no portal
  // access on a screen where every request 403s. Registering them behind the same permission the
  // tab layout checks closes that path.
  //
  // Kept registered while the session is still resolving, so a cold-start deep link isn't dropped
  // before `principal` arrives; once resolved, an unauthorised user can't reach them at all.
  const engineerRoutes = loading || (principal?.type === "user" && can("engineer.dashboard.view"));

  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.text,
        headerStyle: { backgroundColor: colors.card },
        headerTitleStyle: { fontWeight: "700" },
        contentStyle: { backgroundColor: colors.bg },
        statusBarStyle: "dark",
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="set-password" options={{ headerShown: false }} />
      {/* Tab screens sit under the purple header, so their status icons go light. The tab layout
          stays registered for everyone — it renders its own "No engineer access" explanation
          rather than leaving a signed-in user with nowhere to land. */}
      <Stack.Screen name="(tabs)" options={{ headerShown: false, statusBarStyle: "light" }} />
      <Stack.Protected guard={engineerRoutes}>
        <Stack.Screen name="jobs/[id]" options={{ title: "Job" }} />
        <Stack.Screen name="jobs/complete" options={{ title: "Complete Job" }} />
        <Stack.Screen name="kit-requests/new" options={{ title: "Request Kit" }} />
        <Stack.Screen name="transfers/[id]" options={{ title: "Transfer" }} />
        <Stack.Screen name="transfers/new" options={{ title: "New Transfer Request" }} />
        <Stack.Screen name="transfers/sign" options={{ title: "Sign for Stock" }} />
        <Stack.Screen name="van-stock/[id]" options={{ title: "Van Stock Request" }} />
        <Stack.Screen name="van-stock/new" options={{ title: "Request Field Stock" }} />
        <Stack.Screen name="van-stock/return" options={{ title: "Return Stock" }} />
      </Stack.Protected>
    </Stack>
  );
}
