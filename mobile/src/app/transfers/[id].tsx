import React, { useCallback, useState } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  approveTransfer,
  cancelTransfer,
  declineTransfer,
  getTransfer,
} from "@/services/transfer.service";
import { AttachmentThumbs } from "@/components/AttachmentPicker";
import { useAuth } from "@/lib/auth";
import { useLoad } from "@/lib/useLoad";
import { useToast } from "@/lib/toast";
import {
  Badge,
  Button,
  Card,
  DetailSkeleton,
  ErrorText,
  InfoRow,
  Input,
  Screen,
  SectionTitle,
} from "@/components/ui";
import { colors } from "@/lib/theme";
import { formatDateTime, titleCase } from "@/lib/format";

export default function TransferDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { principal } = useAuth();
  const toast = useToast();
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState("");

  const { data: transfer, setData, loading, refreshing, error, refresh } = useLoad(
    useCallback(() => getTransfer(id), [id]),
  );

  const run = async (key: string, fn: () => Promise<typeof transfer>, successMsg?: string) => {
    setBusy(key);
    setActionError(null);
    try {
      const next = await fn();
      if (next) setData(next);
      setDeclining(false);
      if (successMsg) toast.success(successMsg);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  };

  if (loading)
    return (
      <Screen>
        <DetailSkeleton />
      </Screen>
    );
  if (!transfer) {
    return (
      <Screen>
        <ErrorText message={error ?? "Transfer not found."} />
      </Screen>
    );
  }

  const isHolder = principal?.id === transfer.fromEngineerId;
  const isRecipient = principal?.id === transfer.toEngineerId;
  const needsMySignature =
    transfer.status === "completed" &&
    transfer.requireSignature &&
    !transfer.acknowledgedAt &&
    isRecipient;

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <Card>
        <View style={s.rowTop}>
          <Text style={s.code}>{transfer.code}</Text>
          <Badge status={transfer.status} />
        </View>
        <InfoRow
          label="From"
          value={
            transfer.fromEngineerPhone ? (
              <Pressable onPress={() => void Linking.openURL(`tel:${transfer.fromEngineerPhone}`)}>
                <Text style={s.phoneValue}>
                  {transfer.fromEngineerName} · {transfer.fromEngineerPhone}
                </Text>
              </Pressable>
            ) : (
              transfer.fromEngineerName
            )
          }
        />
        <InfoRow label="To" value={transfer.toEngineerName} />
        <InfoRow label="Requested by" value={titleCase(transfer.requestedByKind)} />
        <InfoRow label="Created" value={formatDateTime(transfer.createdAt)} />
        {transfer.completedAt ? <InfoRow label="Completed" value={formatDateTime(transfer.completedAt)} /> : null}
        {transfer.declineReason ? <InfoRow label="Decline reason" value={transfer.declineReason} /> : null}
        {transfer.acknowledgedAt ? (
          <InfoRow label="Signed for" value={formatDateTime(transfer.acknowledgedAt)} />
        ) : null}
      </Card>

      <SectionTitle>Reason</SectionTitle>
      <Card>
        <Text style={s.body}>{transfer.reason}</Text>
        {transfer.notes ? <Text style={s.meta}>{transfer.notes}</Text> : null}
      </Card>

      <SectionTitle>Items</SectionTitle>
      {transfer.lines.map((line) => (
        <Card key={line.id}>
          <View style={s.rowTop}>
            <Text style={s.lineName} numberOfLines={2}>
              {line.itemName}
            </Text>
            <Text style={s.lineQty}>× {line.quantity}</Text>
          </View>
          <Text style={s.meta}>
            {line.ownership === "company" ? "IRM (Company)" : "Customer"}
            {line.sku ? ` · ${line.sku}` : ""}
            {line.uom ? ` · ${line.uom}` : ""}
          </Text>
        </Card>
      ))}

      {transfer.attachments.length > 0 ? (
        <>
          <SectionTitle>Attachments</SectionTitle>
          <Card>
            <AttachmentThumbs urls={transfer.attachments} />
          </Card>
        </>
      ) : null}

      {transfer.receiverSignatureUrl ? (
        <>
          <SectionTitle>Signature</SectionTitle>
          <Card>
            {transfer.acknowledgedAt ? (
              <Text style={s.meta}>Acknowledged {formatDateTime(transfer.acknowledgedAt)}</Text>
            ) : null}
            <Image source={{ uri: transfer.receiverSignatureUrl }} style={s.signature} contentFit="contain" />
          </Card>
        </>
      ) : null}

      <ErrorText message={actionError} />

      {transfer.status === "pending" && isHolder ? (
        <Card>
          <SectionTitle>You hold this stock</SectionTitle>
          <Button
            title="Approve Hand-over"
            onPress={() =>
              // Web parity: approving hands custody of your stock to the other engineer — confirm first.
              Alert.alert(
                "Approve this transfer?",
                "The requested stock moves to the other engineer once you approve.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Approve transfer",
                    onPress: () => void run("approve", () => approveTransfer(transfer.id), "Transfer approved."),
                  },
                ],
              )
            }
            loading={busy === "approve"}
          />
          {declining ? (
            <>
              <Input
                label="Reason (optional)"
                value={declineReason}
                onChangeText={setDeclineReason}
                multiline
                placeholder="Why are you declining?"
              />
              <Button
                title="Decline"
                variant="danger"
                loading={busy === "decline"}
                onPress={() =>
                  void run(
                    "decline",
                    () => declineTransfer(transfer.id, declineReason.trim() || undefined),
                    "Transfer declined.",
                  )
                }
              />
              <Button title="Cancel" variant="ghost" onPress={() => setDeclining(false)} />
            </>
          ) : (
            <Button title="Decline" variant="secondary" onPress={() => setDeclining(true)} />
          )}
        </Card>
      ) : null}

      {transfer.status === "pending" && isRecipient ? (
        <Button
          title="Cancel Request"
          variant="secondary"
          loading={busy === "cancel"}
          onPress={() =>
            Alert.alert(
              "Cancel this transfer?",
              `Transfer ${transfer.code} will be cancelled. This can't be undone.`,
              [
                { text: "Keep it", style: "cancel" },
                {
                  text: "Cancel transfer",
                  style: "destructive",
                  onPress: () => void run("cancel", () => cancelTransfer(transfer.id), "Transfer cancelled."),
                },
              ],
            )
          }
        />
      ) : null}

      {needsMySignature ? (
        <Button
          title="Sign for Received Stock"
          onPress={() => router.push({ pathname: "/transfers/sign", params: { id: transfer.id } })}
        />
      ) : null}
    </Screen>
  );
}

const s = StyleSheet.create({
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  code: { fontSize: 14, fontWeight: "700", color: colors.accent },
  body: { fontSize: 14, color: colors.text },
  meta: { fontSize: 12, color: colors.muted },
  lineName: { fontSize: 14, fontWeight: "700", color: colors.text, flex: 1 },
  lineQty: { fontSize: 14, fontWeight: "800", color: colors.text },
  phoneValue: { fontSize: 14, fontWeight: "600", color: colors.accent, textAlign: "right" },
  signature: { height: 120, borderRadius: 10, backgroundColor: colors.mutedSoft },
});
