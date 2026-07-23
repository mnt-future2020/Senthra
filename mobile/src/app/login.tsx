import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { forgotPassword } from "@/services/account.service";
import { principalName, useAuth } from "@/lib/auth";
import { useBranding } from "@/lib/branding";
import { useToast } from "@/lib/toast";
import { Button, ErrorText, Input } from "@/components/ui";
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
  const [forgotBusy, setForgotBusy] = useState(false);
  const finishLogin = (principal: Principal) => {
    toast.success(`Welcome, ${principalName(principal)}`);
    if (principal.type === "user" && principal.mustResetPassword) {
      router.replace("/set-password");
    } else {
      router.replace("/overview");
    }
  };

  const forgot = async () => {
    if (!email.trim()) {
      setError("Enter your email above first.");
      return;
    }
    setError(null);
    setForgotBusy(true);
    try {
      await forgotPassword(email.trim().toLowerCase());
      toast.success("Reset link sent — check your email.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send the reset link.");
    } finally {
      setForgotBusy(false);
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
    <KeyboardAvoidingView
      style={s.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
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
          <Input
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="••••••••"
            editable={!busy}
            onSubmitEditing={submit}
          />
          <ErrorText message={error} />
          <Button title="Sign In" onPress={submit} loading={busy} />
          <Pressable onPress={() => void forgot()} disabled={forgotBusy} hitSlop={8}>
            <Text style={s.forgotLink}>{forgotBusy ? "Sending reset link…" : "Forgot password?"}</Text>
          </Pressable>
        </View>
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
});
