import React, { useCallback, useState } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import {
  cancelVanStockRemaining,
  cancelVanStockRequest,
  getVanStockRequest,
} from "@/services/vanStock.service";
import { useLoad } from "@/lib/useLoad";
import { useToast } from "@/lib/toast";
import { AttachmentThumbs } from "@/components/AttachmentPicker";
import { WarehousePickupModal } from "@/components/WarehousePickupModal";
import {
  Badge,
  Button,
  Card,
  DetailSkeleton,
  ErrorText,
  InfoRow,
  Screen,
  SectionTitle,
} from "@/components/ui";
import { colors } from "@/lib/theme";
import { formatDateTime, titleCase } from "@/lib/format";
import type { JobKitWarehouse, VanStockLine, VanStockRequest } from "@/types";

const VSR_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  partially_fulfilled: "Partially fulfilled",
  fulfilled: "Fulfilled",
  declined: "Declined",
  cancelled: "Cancelled",
};

/** Web's lineProgress: Excluded / Fulfilled / "n/m done" / Awaiting. */
function lineProgress(line: VanStockLine): string {
  if (line.approvedQty === 0) return "Excluded";
  const target = line.approvedQty ?? line.requestedQty;
  if (line.fulfilledQty >= target) return "Fulfilled";
  if (line.fulfilledQty > 0) return `${line.fulfilledQty}/${target} done`;
  return "Awaiting";
}

/** Web's warehouseCaption (engineer variant). */
function warehouseCaption(r: VanStockRequest): string {
  if (r.type === "return") return `Returning to: ${r.warehouseName ?? r.preferredWarehouseName ?? "—"}`;
  if (r.status === "pending") return `Requested warehouse: ${r.preferredWarehouseName ?? "—"} (pending review)`;
  const sourceIds = new Set(r.lines.map((l) => l.sourceWarehouseId).filter(Boolean));
  if (sourceIds.size > 1) return `Collect from ${sourceIds.size} warehouses — see each line below`;
  return `Collect from: ${r.warehouseName ?? r.lines.find((l) => l.sourceWarehouseName)?.sourceWarehouseName ?? "—"}`;
}

export default function VanStockDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const toast = useToast();
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pickupWarehouse, setPickupWarehouse] = useState<JobKitWarehouse | null>(null);

  const { data: request, setData, loading, refreshing, error, refresh } = useLoad(
    useCallback(() => getVanStockRequest(id), [id]),
  );

  const run = async (key: string, fn: () => Promise<typeof request>, successMsg?: string) => {
    setBusy(key);
    setActionError(null);
    try {
      const next = await fn();
      if (next) setData(next);
      if (successMsg) toast.success(successMsg);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  };

  const confirmCancel = (remaining: boolean) => {
    Alert.alert(
      remaining ? "Cancel the remaining quantity?" : "Cancel this request?",
      remaining
        ? "What's already been issued stays on your van; only the unfulfilled remainder is cancelled."
        : "This can't be undone — the warehouse won't see it anymore.",
      [
        { text: "Keep it", style: "cancel" },
        {
          text: remaining ? "Cancel remaining" : "Cancel request",
          style: "destructive",
          onPress: () =>
            void run(
              remaining ? "cancel-remaining" : "cancel",
              () => (remaining ? cancelVanStockRemaining(request!.id) : cancelVanStockRequest(request!.id)),
              remaining ? "Remaining quantity cancelled." : "Request cancelled.",
            ),
        },
      ],
    );
  };

  if (loading)
    return (
      <Screen>
        <DetailSkeleton />
      </Screen>
    );
  if (!request) {
    return (
      <Screen>
        <ErrorText message={error ?? "Request not found."} />
      </Screen>
    );
  }

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <Card>
        <View style={s.rowTop}>
          <Text style={s.code}>{request.code}</Text>
          <Badge status={request.status} label={VSR_STATUS_LABELS[request.status]} />
        </View>
        <View style={s.badgeRow}>
          <Badge status={request.type} label={titleCase(request.type)} />
          {request.createdVia === "walk_in" ? <Badge status="draft" label="Walk-in" /> : null}
          {request.stale ? <Badge status="high" label="Stale" /> : null}
          <Badge status={request.priority} />
        </View>
        <Text style={s.caption}>{warehouseCaption(request)}</Text>
        <InfoRow
          label="Progress"
          value={`${request.progress.qtyFulfilled}/${request.progress.qty} units · ${request.progress.linesDone}/${request.progress.lines} lines`}
        />
        <InfoRow label="Raised" value={formatDateTime(request.createdAt)} />
        {request.reviewedAt ? <InfoRow label="Reviewed" value={formatDateTime(request.reviewedAt)} /> : null}
        {request.decisionNote ? <InfoRow label="Declined" value={request.decisionNote} /> : null}
        {request.closeShortNote ? <InfoRow label="Closed short" value={request.closeShortNote} /> : null}
      </Card>

      <SectionTitle>Reason</SectionTitle>
      <Card>
        <Text style={s.body}>&ldquo;{request.reason}&rdquo;</Text>
        {request.notes ? <Text style={s.meta}>{request.notes}</Text> : null}
      </Card>

      <SectionTitle>Lines</SectionTitle>
      {request.lines.map((line) => (
        <Card key={line.id}>
          <View style={s.rowTop}>
            <Text style={s.lineName} numberOfLines={2}>
              {line.itemName}
            </Text>
            <Text style={s.progressText}>{lineProgress(line)}</Text>
          </View>
          <Text style={s.meta}>
            Requested {line.requestedQty}
            {line.approvedQty !== null && line.approvedQty !== line.requestedQty
              ? ` · approved ${line.approvedQty}`
              : ""}
            {line.code ? ` · ${line.code}` : ""}
          </Text>
          {line.sourceWarehouse ? (
            <Pressable style={s.warehouseRow} onPress={() => setPickupWarehouse(line.sourceWarehouse)}>
              <Ionicons name="location" size={14} color={colors.accent} />
              <Text style={s.warehouseLink}>
                Collect from {line.sourceWarehouse.name}
                {line.sourceWarehouse.code ? ` (${line.sourceWarehouse.code})` : ""}
              </Text>
            </Pressable>
          ) : line.sourceWarehouseName ? (
            <Text style={s.meta}>
              Collect from {line.sourceWarehouseName}
              {line.sourceWarehouseCode ? ` (${line.sourceWarehouseCode})` : ""}
            </Text>
          ) : null}
        </Card>
      ))}

      {request.attachments.length > 0 ? (
        <>
          <SectionTitle>Attachments</SectionTitle>
          <Card>
            <AttachmentThumbs urls={request.attachments} />
          </Card>
        </>
      ) : null}

      {request.fulfilments.length > 0 ? (
        <>
          <SectionTitle>{request.type === "return" ? "Received" : "Issued"}</SectionTitle>
          {request.fulfilments.map((f) => (
            <Card key={f.id}>
              <Text style={s.lineName}>
                #{f.sequence} · {formatDateTime(f.postedAt)} · {f.performedBy}
              </Text>
              {f.lines.map((l) => (
                <View key={l.id} style={s.fulfilmentLine}>
                  <Text style={s.meta}>
                    {l.itemName} ×{l.qty}
                    {l.condition === "damaged" ? ` · damaged${l.damageReason ? ` — "${l.damageReason}"` : ""}` : " · good"}
                  </Text>
                  {l.condition === "damaged" && l.damagePhotoUrl ? (
                    <Pressable onPress={() => void Linking.openURL(l.damagePhotoUrl!)}>
                      <Text style={s.photoLink}>photo</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </Card>
          ))}
        </>
      ) : null}

      <ErrorText message={actionError} />

      {request.status === "pending" ? (
        <Button
          title="Cancel Request"
          variant="danger"
          loading={busy === "cancel"}
          onPress={() => confirmCancel(false)}
        />
      ) : null}
      {request.status === "partially_fulfilled" ? (
        <Button
          title="Cancel Remaining"
          variant="secondary"
          loading={busy === "cancel-remaining"}
          onPress={() => confirmCancel(true)}
        />
      ) : null}

      <WarehousePickupModal warehouse={pickupWarehouse} onClose={() => setPickupWarehouse(null)} />
    </Screen>
  );
}

const s = StyleSheet.create({
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  code: { fontSize: 14, fontWeight: "700", color: colors.accent },
  badgeRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  caption: { fontSize: 13, fontWeight: "600", color: colors.text },
  body: { fontSize: 14, color: colors.text, fontStyle: "italic" },
  meta: { fontSize: 12, color: colors.muted },
  lineName: { fontSize: 14, fontWeight: "700", color: colors.text, flex: 1 },
  progressText: { fontSize: 13, fontWeight: "700", color: colors.info },
  warehouseRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  warehouseLink: { fontSize: 13, fontWeight: "600", color: colors.accent },
  fulfilmentLine: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  photoLink: { fontSize: 12, fontWeight: "700", color: colors.accent, textDecorationLine: "underline" },
});
