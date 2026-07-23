import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import { changeOwnPassword } from "@/services/account.service";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { Button, ErrorText, Input } from "@/components/ui";
import { colors } from "@/lib/theme";

// First-login forced password change: the backend walls off every permission-gated
// endpoint until the temp password is replaced (mustResetPassword).
export default function SetPasswordScreen() {
  const router = useRouter();
  const toast = useToast();
  const { refreshPrincipal, logout } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changeOwnPassword({ newPassword: password });
      await refreshPrincipal();
      toast.success("Password updated.");
      router.replace("/overview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
        <Text style={s.title}>Set your password</Text>
        <Text style={s.subtitle}>
          You signed in with a temporary password. Choose a new one to continue.
        </Text>
        <Input
          label="New password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          editable={!busy}
        />
        <Input
          label="Confirm password"
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry
          editable={!busy}
          onSubmitEditing={submit}
        />
        <ErrorText message={error} />
        <Button title="Save and Continue" onPress={submit} loading={busy} />
        <Button
          title="Sign out"
          variant="ghost"
          onPress={() => {
            void logout().then(() => router.replace("/login"));
          }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  container: { flexGrow: 1, justifyContent: "center", padding: 24, gap: 14 },
  title: { fontSize: 22, fontWeight: "800", color: colors.text },
  subtitle: { fontSize: 14, color: colors.muted, marginBottom: 10 },
});
