import React, { useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { principalName, useAuth } from "@/lib/auth";
import { useBranding } from "@/lib/branding";
import { useToast } from "@/lib/toast";
import { Button, ErrorText, Input, PasswordInput } from "@/components/ui";
import { colors } from "@/lib/theme";
import type { Principal } from "@/types";

export default function LoginScreen() {
  const router = useRouter();
  const toast = useToast();
  const branding = useBranding();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const finishLogin = (principal: Principal) => {
    toast.success(`Welcome, ${principalName(principal)}`);
    if (principal.type === "user" && principal.mustResetPassword) {
      router.replace("/set-password");
    } else {
      router.replace("/overview");
    }
  };

  const submit = async () => {
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const principal = await login(email, password);
      finishLogin(principal);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    // "padding" on both platforms — edge-to-edge Android no longer resizes the
    // window for the keyboard, so without it the fields sit underneath.
    <KeyboardAvoidingView style={s.flex} behavior="padding">
      <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
        <View style={s.brandWrap}>
          {branding?.logoUrl ? (
            <Image source={{ uri: branding.logoUrl }} style={s.logoImage} contentFit="contain" />
          ) : (
            <>
              <View style={s.logoDot}>
                <Text style={s.logoText}>S</Text>
              </View>
              <Text style={s.brand}>Senthra</Text>
            </>
          )}
          <Text style={s.subtitle}>Engineer Portal</Text>
        </View>

        <View style={s.form}>
          <Input
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            placeholder="you@company.com"
            editable={!busy}
          />
          <PasswordInput
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            editable={!busy}
            onSubmitEditing={submit}
          />
          <ErrorText message={error} />
          <Button title="Sign In" onPress={submit} loading={busy} />
          <Pressable onPress={() => router.push("/forgot-password")} hitSlop={8}>
            <Text style={s.forgotLink}>Forgot password?</Text>
          </Pressable>
        </View>

        {/* Reachable WITHOUT signing in — that is the whole point of it being here rather than only
            in Account. Someone whose data we hold may have no working account at all (a leaver, a
            locked-out engineer), and they are exactly the person most likely to be asking. */}
        <Pressable onPress={() => router.push("/privacy")} hitSlop={12} style={s.footer}>
          <Text style={s.footerLink}>Privacy notice</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  container: { flexGrow: 1, justifyContent: "center", padding: 24, gap: 28 },
  brandWrap: { alignItems: "center", gap: 6 },
  logoDot: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  logoText: { color: "#fff", fontSize: 28, fontWeight: "800" },
  logoImage: { width: 240, height: 110, marginBottom: 4 },
  brand: { fontSize: 26, fontWeight: "800", color: colors.text },
  subtitle: { fontSize: 14, color: colors.muted },
  form: { gap: 14 },
  forgotLink: { fontSize: 13, fontWeight: "600", color: colors.accent, textAlign: "center", marginTop: 6 },
  footer: { alignItems: "center" },
  footerLink: { fontSize: 12, fontWeight: "600", color: colors.faint },
});
