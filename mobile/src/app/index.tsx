import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { Redirect } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useAuth } from "@/lib/auth";
import { useBranding } from "@/lib/branding";
import { colors } from "@/lib/theme";

// Branded splash shown while the stored session is validated. It takes over
// seamlessly from the native splash (same purple + logo card), so the app
// opens with one continuous splash before login / the dashboard.
function BrandSplash() {
  const branding = useBranding();

  useEffect(() => {
    // The native splash hides only once this one is on screen.
    void SplashScreen.hideAsync().catch(() => {});
  }, []);

  return (
    <View style={s.splash}>
      <View style={s.logoCard}>
        {branding?.logoUrl ? (
          <Image source={{ uri: branding.logoUrl }} style={s.logoImage} contentFit="contain" />
        ) : (
          <Text style={s.logoS}>S</Text>
        )}
      </View>
      <Text style={s.tagline}>Engineer Portal</Text>
    </View>
  );
}

// Entry gate: animated splash while the stored session is validated (with a
// minimum display so it never flashes), then route by principal state.
export default function Index() {
  const { principal, loading } = useAuth();
  const [minShown, setMinShown] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setMinShown(true), 3000);
    return () => clearTimeout(t);
  }, []);

  if (loading || !minShown) return <BrandSplash />;
  if (!principal) return <Redirect href="/login" />;
  if (principal.type === "user" && principal.mustResetPassword) {
    return <Redirect href="/set-password" />;
  }
  return <Redirect href="/overview" />;
}

const s = StyleSheet.create({
  splash: { flex: 1, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  logoCard: {
    width: 148,
    height: 148,
    borderRadius: 36,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000000",
    shadowOpacity: 0.2,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  logoS: { fontSize: 80, fontWeight: "800", color: colors.accent },
  logoImage: { width: 112, height: 112 },
  tagline: { fontSize: 15, color: "rgba(255,255,255,0.85)", marginTop: 16 },
});
