import React, { useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { forgotPassword } from "@/services/account.service";
import { Button, ErrorText, Input } from "@/components/ui";
import { colors } from "@/lib/theme";

// Forgot-password, mirroring the web page: one screen, two states — the email
// form, then the "Check your email" confirmation. The API always responds
// generically (no email enumeration), so success only means it was accepted;
// the reset itself completes via the emailed link.
export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      setError("Enter your email.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await forgotPassword(trimmed);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const backToLogin = () => router.back();

  return (
    <KeyboardAvoidingView style={s.flex} behavior="padding">
      <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
        {sent ? (
          <View style={s.center}>
            <View style={s.iconTile}>
              <Ionicons name="mail-open" size={26} color={colors.accent} />
            </View>
            <Text style={s.title}>Check your email</Text>
            <Text style={s.body}>
              If <Text style={s.bodyStrong}>{email.trim().toLowerCase()}</Text> is registered,
              we&rsquo;ve sent a link to reset your password. It is valid for 1 hour.
            </Text>
            <Pressable onPress={backToLogin} hitSlop={8} style={s.backRow}>
              <Ionicons name="arrow-back" size={16} color={colors.accent} />
              <Text style={s.backLinkAccent}>Back to login</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={s.center}>
              <Text style={s.title}>Forgot password?</Text>
              <Text style={s.body}>
                Enter your email and we&rsquo;ll send you a link to reset your password.
              </Text>
            </View>
            <View style={s.form}>
              <Input
                label="Email"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                placeholder="user@company.com"
                editable={!busy}
                onSubmitEditing={() => void submit()}
              />
              <ErrorText message={error} />
              <Button title={busy ? "Sending…" : "Send reset link"} onPress={() => void submit()} loading={busy} />
            </View>
            <Pressable onPress={backToLogin} hitSlop={8} style={s.backRow}>
              <Ionicons name="arrow-back" size={16} color={colors.muted} />
              <Text style={s.backLinkMuted}>Back to login</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  container: { flexGrow: 1, justifyContent: "center", padding: 24, gap: 24 },
  center: { alignItems: "center", gap: 8 },
  iconTile: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: colors.accentSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  title: { fontSize: 24, fontWeight: "800", color: colors.text, textAlign: "center" },
  body: { fontSize: 14, color: colors.muted, textAlign: "center", maxWidth: 300 },
  bodyStrong: { fontWeight: "700", color: colors.text },
  form: { gap: 14 },
  backRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 4 },
  backLinkAccent: { fontSize: 14, fontWeight: "700", color: colors.accent },
  backLinkMuted: { fontSize: 14, fontWeight: "700", color: colors.muted },
});
