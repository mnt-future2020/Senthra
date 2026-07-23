import React from "react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { AuthProvider } from "@/lib/auth";
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
        {/* Tab screens sit under the purple header, so their status icons go light. */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false, statusBarStyle: "light" }} />
        <Stack.Screen name="jobs/[id]" options={{ title: "Job" }} />
        <Stack.Screen name="jobs/complete" options={{ title: "Complete Job" }} />
        <Stack.Screen name="kit-requests/new" options={{ title: "Request Kit" }} />
        <Stack.Screen name="transfers/[id]" options={{ title: "Transfer" }} />
        <Stack.Screen name="transfers/new" options={{ title: "New Transfer Request" }} />
        <Stack.Screen name="transfers/sign" options={{ title: "Sign for Stock" }} />
        <Stack.Screen name="van-stock/[id]" options={{ title: "Van Stock Request" }} />
        <Stack.Screen name="van-stock/new" options={{ title: "Request Field Stock" }} />
        <Stack.Screen name="van-stock/return" options={{ title: "Return Stock" }} />
      </Stack>
      </ToastProvider>
    </AuthProvider>
  );
}
