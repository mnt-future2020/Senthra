import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Signature from "react-native-signature-canvas";
import { acknowledgeTransfer } from "@/services/transfer.service";
import { useToast } from "@/lib/toast";
import { Button, ErrorText } from "@/components/ui";
import { colors } from "@/lib/theme";

// Sign-on-glass acknowledgment for a received transfer (required when the
// engineerTransferRequireSignature setting is on). The pad returns a PNG data URI
// which the backend uploads to Cloudinary.
export default function SignTransferScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (signature: string) => {
    setBusy(true);
    setError(null);
    try {
      await acknowledgeTransfer(id, signature);
      toast.success("Transfer acknowledged.");
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the signature.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.container}>
      <Text style={s.hint}>Sign below to confirm you received the stock.</Text>
      <View style={s.padWrap}>
        <Signature
          onOK={(sig: string) => void submit(sig)}
          onEmpty={() => setError("Please sign before saving.")}
          descriptionText=""
          clearText="Clear"
          confirmText="Save"
          webStyle={`.m-signature-pad--footer .button { background-color: ${colors.accent}; color: #fff; }`}
          backgroundColor={colors.card}
          penColor={colors.text}
        />
      </View>
      <ErrorText message={error} />
      {busy ? <Text style={s.hint}>Saving…</Text> : null}
      <Button title="Cancel" variant="secondary" onPress={() => router.back()} />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 16, gap: 12 },
  hint: { fontSize: 13, color: colors.muted },
  padWrap: {
    flex: 1,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
  },
});
