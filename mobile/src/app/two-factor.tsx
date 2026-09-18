import React, { useCallback, useEffect, useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ApiError } from "@/lib/api";
import { principalName, useAuth } from "@/lib/auth";
import { postLoginRoute } from "@/lib/postLoginRoute";
import { useToast } from "@/lib/toast";
import { deadlinesFrom, elapsedFrom, formatCountdown, secondsUntil } from "@/lib/twoFactorCountdown";
import { AuthBrand, Button, ErrorText, Input, LoadingView } from "@/components/ui";
import { colors } from "@/lib/theme";
import type { Principal } from "@/types";

// The second half of sign-in when email two-factor is switched on: the password was accepted, but no
// session exists until the emailed code is proven. Mirrors the web's TwoFactorStep — same wording,
// same countdowns, same recovery — because it is the same challenge, and an engineer who has seen
// one should recognise the other.

export default function TwoFactorScreen() {
  const router = useRouter();
  const toast = useToast();
  const {
    pendingTwoFactor: pending,
    pendingTwoFactorAt: receivedAt,
    verifyTwoFactor,
    resendTwoFactor,
    cancelTwoFactor,
  } = useAuth();

  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  // Ticks once a second purely to redraw the two countdowns. Held as state rather than derived, so
  // the numbers fall on their own while the engineer waits for an email that is already in flight.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  /** Back to the credential form, carrying the server's reason when it ended the challenge. */
  const toLogin = useCallback(
    (reason?: string) => {
      if (reason) toast.error(reason);
      router.replace("/login");
    },
    [router, toast],
  );

  // Nothing pending means this screen has no business being on top: either the challenge was just
  // spent (verify succeeded and we are already navigating away) or someone reached the route with no
  // sign-in behind it. Both end at the credential form.
  //
  // It does NOT fetch. Two places ask the server for a live challenge — the login screen's 202 and
  // the provider's boot probe — and both hand it over before this screen opens, so a fetch here
  // would be a third way of asking with nothing left to ask about.
  useEffect(() => {
    if (!pending) router.replace("/login");
  }, [pending, router]);

  /**
   * 410 Gone = the challenge is finished (too many wrong codes, expired, already used).
   *
   * Nothing here can succeed any more, so staying strands the engineer: Verify keeps failing and
   * Resend silently does nothing. Go back to the credential form carrying the reason, so they read
   * "too many incorrect codes, sign in again" rather than staring at a dead screen.
   */
  const handledAsEnded = (err: unknown): boolean => {
    if (err instanceof ApiError && err.status === 410) {
      toLogin(err.message);
      return true;
    }
    return false;
  };

  const finish = (principal: Principal) => {
    toast.success(`Welcome, ${principalName(principal)}`);
    router.replace(postLoginRoute(principal));
  };

  const verify = async () => {
    const trimmed = code.trim();
    if (!trimmed) {
      setError("Enter the 6-digit code from your email.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      finish(await verifyTwoFactor(trimmed));
    } catch (err) {
      if (handledAsEnded(err)) return;
      setError(err instanceof Error ? err.message : "Verification failed.");
      // Clear the field so the next attempt starts clean rather than editing a rejected code.
      setCode("");
      setBusy(false);
    }
    // Deliberately no `finally`: on success the screen is already navigating away, and re-enabling
    // the button first would flash a live form over a screen that is leaving.
  };

  const resend = async () => {
    setError(null);
    setResending(true);
    try {
      await resendTwoFactor();
      setCode("");
      toast.success("A new code is on its way.");
    } catch (err) {
      if (handledAsEnded(err)) return;
      setError(err instanceof Error ? err.message : "Couldn't resend the code.");
    } finally {
      setResending(false);
    }
  };

  const cancel = async () => {
    await cancelTwoFactor();
    router.replace("/login");
  };

  if (!pending) return <LoadingView />;

  const deadlines = deadlinesFrom(pending, receivedAt);
  const at = elapsedFrom(now, receivedAt);
  const resendIn = secondsUntil(deadlines.resendAtMs, at);
  const expiresIn = secondsUntil(deadlines.expiresAtMs, at);
  const resendsLeft = pending.resendsRemaining;
  const canResend = resendIn === 0 && resendsLeft > 0 && !resending && !busy;

  return (
    <KeyboardAvoidingView style={s.flex} behavior="padding">
      <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
        {/* The same mark the credential screen leads with. This is step two of ONE sign-in, and a
            second screen with no branding reads as a different app — or, worse, as a phishing page
            asking for a code. */}
        <AuthBrand />

        <View style={s.head}>
          <Text style={s.title}>Check your email</Text>
          <Text style={s.subtitle}>
            We sent a 6-digit code to <Text style={s.email}>{pending.email}</Text>.
          </Text>
        </View>

        <View style={s.form}>
          <Input
            label="Verification code"
            value={code}
            onChangeText={(v) => setCode(v.replace(/[^0-9]/g, "").slice(0, 6))}
            // A numeric pad, because the code is always six digits — and `one-time-code` lets both
            // platforms offer the code straight from the notification.
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            autoFocus
            placeholder="000000"
            editable={!busy}
            onSubmitEditing={verify}
            style={s.codeInput}
          />
          <ErrorText message={error} />
          <Button title="Verify" onPress={verify} loading={busy} />

          <Text style={s.expiry}>
            {expiresIn > 0
              ? `This code expires in ${formatCountdown(expiresIn)}.`
              : "This code has expired — send a new one."}
          </Text>

          <Pressable onPress={resend} disabled={!canResend} hitSlop={8}>
            <Text style={[s.action, !canResend && s.actionDisabled]}>
              {resendsLeft === 0
                ? "No resends left"
                : resending
                  ? "Sending…"
                  : resendIn > 0
                    ? `Resend code in ${resendIn}s`
                    : "Resend code"}
            </Text>
          </Pressable>
          {resendsLeft > 0 && resendIn === 0 ? (
            <Text style={s.resendsLeft}>
              {resendsLeft} resend{resendsLeft === 1 ? "" : "s"} left
            </Text>
          ) : null}

          <Pressable onPress={cancel} disabled={busy} hitSlop={8}>
            <Text style={s.back}>Use a different account</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  container: { flexGrow: 1, justifyContent: "center", padding: 24, gap: 28 },
  head: { alignItems: "center", gap: 8 },
  title: { fontSize: 24, fontWeight: "800", color: colors.text, textAlign: "center" },
  subtitle: { fontSize: 14, color: colors.muted, textAlign: "center" },
  email: { fontWeight: "700", color: colors.text },
  form: { gap: 14 },
  codeInput: { fontSize: 22, letterSpacing: 6, textAlign: "center", fontWeight: "700" },
  expiry: { fontSize: 12, color: colors.faint, textAlign: "center" },
  action: { fontSize: 13, fontWeight: "700", color: colors.accent, textAlign: "center", marginTop: 4 },
  actionDisabled: { color: colors.faint },
  resendsLeft: { fontSize: 11, color: colors.faint, textAlign: "center", marginTop: -8 },
  back: { fontSize: 13, fontWeight: "600", color: colors.muted, textAlign: "center", marginTop: 10 },
});
