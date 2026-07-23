import React, { useCallback, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import {
  acceptOwnJob,
  getOwnJob,
  rejectOwnJob,
  startOwnJob,
} from "@/services/engineer.service";
import { cancelKitRequest, listMyKitRequests } from "@/services/kitRequest.service";
import { useAuth } from "@/lib/auth";
import { useLoad } from "@/lib/useLoad";
import { useSocketRefresh } from "@/lib/useSocketRefresh";
import { useToast } from "@/lib/toast";
import {
  crossWarehouseReturnNote,
  GOODS_STATUS_LABELS,
  LINE_TYPE_LABEL,
  returnLocationNote,
} from "@/lib/jobKit";
import { WarehousePickupModal } from "@/components/WarehousePickupModal";
import {
  Badge,
  Button,
  Card,
  DetailSkeleton,
  EmptyState,
  ErrorText,
  InfoRow,
  Input,
  Screen,
  SectionTitle,
} from "@/components/ui";
import { colors } from "@/lib/theme";
import { formatDate, formatDateTime, joinAddress, titleCase } from "@/lib/format";
import type { JobKitLine, JobKitWarehouse, KitRequest, KitRequestLine } from "@/types";

function KitLineCard({
  line,
  lines,
  onWarehousePress,
}: {
  line: JobKitLine;
  lines: JobKitLine[];
  onWarehousePress: (w: JobKitWarehouse) => void;
}) {
  const crossNote = crossWarehouseReturnNote(line, lines);
  return (
    <Card>
      <View style={s.lineTop}>
        <Text style={s.lineName} numberOfLines={2}>
          {line.itemName}
        </Text>
        <Text style={s.lineQty}>× {line.qty}</Text>
      </View>
      {line.description ? <Text style={s.lineMeta}>{line.description}</Text> : null}
      <Text style={s.lineMeta}>
        {LINE_TYPE_LABEL[line.lineType] ?? titleCase(line.lineType)}
        {line.seCode ? ` · ${line.seCode}` : ""}
      </Text>
      {line.warehouse ? (
        <Pressable style={s.warehouseRow} onPress={() => onWarehousePress(line.warehouse!)}>
          <Ionicons name="location" size={14} color={colors.accent} />
          <Text style={s.warehouseLink}>
            {line.warehouse.name}
            {line.warehouse.code ? ` (${line.warehouse.code})` : ""}
          </Text>
        </Pressable>
      ) : line.warehouseName ? (
        <Text style={s.lineMeta}>
          {line.warehouseName}
          {line.warehouseCode ? ` (${line.warehouseCode})` : ""}
        </Text>
      ) : null}
      <Text style={s.lineTallies}>
        Issued {line.issued} · Used {line.used} · Returned {line.returned} · On van {line.remaining}
      </Text>
      {crossNote ? <Text style={s.crossNote}>{crossNote}</Text> : null}
      {line.vanSources.length > 0 ? (
        <>
          {line.vanSources.map((v, i) => (
            <Text key={`${v.transferCode}-${i}`} style={s.vanSource}>
              From van: {v.engineerName} ×{v.quantity}
              {v.status === "pending" ? " · awaiting handover" : ""}
            </Text>
          ))}
          <Text style={s.lineMeta}>{returnLocationNote(line)}</Text>
        </>
      ) : null}
      {line.notes ? <Text style={s.lineMeta}>Notes: {line.notes}</Text> : null}
    </Card>
  );
}

function KitLineChips({ lines }: { lines: KitRequestLine[] }) {
  return (
    <View style={s.chipsRow}>
      {lines.map((l) => {
        const tint =
          l.source === "customer_stock"
            ? { bg: colors.accentSoft, fg: colors.accent }
            : l.source === "misc"
              ? { bg: colors.mutedSoft, fg: colors.muted }
              : { bg: colors.card, fg: colors.text };
        return (
          <View key={l.id} style={[s.krChip, { backgroundColor: tint.bg }]}>
            <Text style={[s.krChipText, { color: tint.fg }]}>
              {l.itemName} ×{l.qty}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { can } = useAuth();
  const toast = useToast();
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [pickupWarehouse, setPickupWarehouse] = useState<JobKitWarehouse | null>(null);

  const { data: job, setData: setJob, loading, refreshing, error, refresh } = useLoad(
    useCallback(() => getOwnJob(id), [id]),
  );
  const { data: kitRequests, reload: reloadKitRequests } = useLoad(
    useCallback(() => listMyKitRequests({ jobId: id, pageSize: 50 }).then((r) => r.requests), [id]),
  );

  useSocketRefresh(["kit_request:updated"], () => void reloadKitRequests());

  const run = async (key: string, fn: () => Promise<typeof job>, successMsg?: string) => {
    setBusy(key);
    setActionError(null);
    try {
      const next = await fn();
      if (next) setJob(next);
      setRejecting(false);
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
  if (!job) {
    return (
      <Screen>
        <ErrorText message={error ?? "Job not found."} />
      </Screen>
    );
  }

  const address = joinAddress([job.addressLine1, job.addressLine2, job.city, job.county, job.postcode]);
  const directionsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    joinAddress([job.addressLine1, job.addressLine2, job.city, job.county, job.postcode, job.country]),
  )}`;
  const fixings = [
    job.floor ? `Floor ${job.floor}` : null,
    job.suite ? `Suite ${job.suite}` : null,
    job.rack ? `Rack ${job.rack}` : null,
    job.shelf ? `Shelf ${job.shelf}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Mirrors the web detail's derived flags (EngineerJobDetail.tsx).
  const stockLines = job.kitLines.filter((l) => l.lineType !== "misc");
  const goodsCollected = stockLines.every((l) => l.issued >= l.qty);
  const kitLocked = job.goodsStatus === "reconciled";
  const showKitCard =
    (job.status === "accepted" || job.status === "in_progress") && can("engineer.jobs.request_kit");
  const canRequestKit = showKitCard && !kitLocked;

  const openKitRequest = () =>
    router.push({ pathname: "/kit-requests/new", params: { jobId: job.id, jobNumber: job.jobNumber } });

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <Card>
        <View style={s.headerTop}>
          <Text style={s.jobNumber}>{job.jobNumber}</Text>
          <Badge status={job.status} />
        </View>
        <Text style={s.jobName}>{job.name}</Text>
        <View style={s.badgeRow}>
          <Badge status={job.priority} />
          <Badge status={job.goodsStatus} label={GOODS_STATUS_LABELS[job.goodsStatus]} />
        </View>
      </Card>

      <ErrorText message={error} />
      <ErrorText message={actionError} />

      {job.status === "assigned" ? (
        <Card>
          <SectionTitle>Respond to assignment</SectionTitle>
          <Button
            title="Accept job"
            onPress={() => void run("accept", () => acceptOwnJob(job.id), "Job accepted.")}
            loading={busy === "accept"}
          />
          {rejecting ? (
            <>
              <Text style={s.hint}>
                Tell the project manager why you cannot take this job (optional). They will be
                notified and can reassign it.
              </Text>
              <Input
                value={rejectReason}
                onChangeText={setRejectReason}
                multiline
                maxLength={500}
                placeholder="Reason (optional)"
                autoFocus
              />
              <Button
                title="Confirm reject"
                variant="danger"
                loading={busy === "reject"}
                onPress={() =>
                  void run(
                    "reject",
                    () => rejectOwnJob(job.id, rejectReason),
                    "Job rejected. The project manager has been notified.",
                  )
                }
              />
              <Button title="Cancel" variant="ghost" onPress={() => setRejecting(false)} />
            </>
          ) : (
            <Button title="Reject" variant="secondary" onPress={() => setRejecting(true)} />
          )}
        </Card>
      ) : null}

      {job.status === "accepted" ? (
        <>
          <Button
            title="Start work"
            disabled={!goodsCollected}
            onPress={() => void run("start", () => startOwnJob(job.id), "Job started. You are now on site.")}
            loading={busy === "start"}
          />
          {!goodsCollected ? <Text style={s.hint}>Collect your kit from the warehouse first</Text> : null}
          {canRequestKit ? <Button title="Request items" variant="secondary" onPress={openKitRequest} /> : null}
        </>
      ) : null}

      {job.status === "in_progress" ? (
        <>
          <Button
            title="Complete work"
            onPress={() => router.push({ pathname: "/jobs/complete", params: { id: job.id } })}
          />
          {canRequestKit ? <Button title="Request items" variant="secondary" onPress={openKitRequest} /> : null}
        </>
      ) : null}

      <SectionTitle>Details</SectionTitle>
      <Card>
        <InfoRow label="Customer" value={job.customerName ?? "—"} />
        <InfoRow label="Project" value={job.projectName ?? "—"} />
        {job.customerRef ? <InfoRow label="Customer ref" value={job.customerRef} /> : null}
        {job.schemeNo ? <InfoRow label="Scheme no." value={job.schemeNo} /> : null}
        <InfoRow label="Type" value={titleCase(job.jobType)} />
        {job.technology ? <InfoRow label="Technology" value={job.technology} /> : null}
        <InfoRow label="Installer" value={titleCase(job.installerType)} />
        {job.supplierName ? <InfoRow label="Supplier" value={job.supplierName} /> : null}
        {job.trsArea ? <InfoRow label="TRS area" value={job.trsArea} /> : null}
      </Card>

      <SectionTitle>Site &amp; address</SectionTitle>
      <Card>
        <InfoRow label="Site" value={job.siteName ?? "—"} />
        {address ? <InfoRow label="Address" value={address} /> : null}
        {fixings ? <InfoRow label="Location" value={fixings} /> : null}
        {address ? (
          <Button
            title="Directions"
            variant="secondary"
            small
            onPress={() => void Linking.openURL(directionsUrl)}
          />
        ) : null}
      </Card>

      <SectionTitle>Schedule</SectionTitle>
      <Card>
        <InfoRow label="Completion date" value={formatDate(job.completionDate)} />
        <InfoRow label="Assigned" value={formatDate(job.assignedAt)} />
        <InfoRow label="Accepted" value={formatDate(job.acceptedAt)} />
        <InfoRow label="Accepted by" value={job.acceptedBy ?? "—"} />
        <InfoRow label="Work started" value={formatDateTime(job.startedAt)} />
        <InfoRow label="Work completed" value={formatDateTime(job.completedAt)} />
      </Card>

      <SectionTitle>Planner &amp; engineer</SectionTitle>
      <Card>
        <InfoRow label="Engineer" value={job.assignedEngineerName ?? "—"} />
        <InfoRow label="Engineer email" value={job.assignedEngineerEmail ?? "—"} />
        <InfoRow label="Planner" value={job.plannerName ?? "—"} />
        <InfoRow label="Planner phone" value={job.plannerPhone ?? "—"} />
      </Card>

      {job.status === "rejected" && job.rejectReason ? (
        <>
          <SectionTitle>Rejected</SectionTitle>
          <Card>
            <InfoRow label="Reason" value={job.rejectReason} />
          </Card>
        </>
      ) : null}

      {job.notes ? (
        <>
          <SectionTitle>Notes</SectionTitle>
          <Card>
            <Text style={s.notes}>{job.notes}</Text>
          </Card>
        </>
      ) : null}

      <SectionTitle>Kit ({job.kitLines.length})</SectionTitle>
      {job.kitLines.length === 0 ? (
        <EmptyState title="No kit lines on this job" />
      ) : (
        job.kitLines.map((line) => (
          <KitLineCard key={line.id} line={line} lines={job.kitLines} onWarehousePress={setPickupWarehouse} />
        ))
      )}

      {showKitCard ? (
        <>
          <SectionTitle>Additional kit</SectionTitle>
          {kitLocked ? (
            <Text style={s.hint}>Goods reconciled — kit locked, no more requests.</Text>
          ) : (
            <Button title="Request items" variant="secondary" onPress={openKitRequest} />
          )}
          {(kitRequests ?? []).length === 0 ? (
            <EmptyState title="No kit requests on this job yet" />
          ) : (
            (kitRequests ?? []).map((kr: KitRequest) => (
              <Card key={kr.id}>
                <View style={s.headerTop}>
                  <Text style={s.krCode}>{kr.code}</Text>
                  <View style={s.krRight}>
                    <Badge status={kr.status} />
                    <Text style={s.krDate}>{formatDate(kr.createdAt)}</Text>
                  </View>
                </View>
                <KitLineChips lines={kr.lines} />
                {kr.reason ? <Text style={s.krReason}>&ldquo;{kr.reason}&rdquo;</Text> : null}
                {kr.status === "declined" && kr.decisionNote ? (
                  <Text style={s.lineMeta}>Planner: {kr.decisionNote}</Text>
                ) : null}
                {kr.status === "approved" ? (
                  kr.fulfillmentMode === "engineer_transfer" || kr.fulfillmentMode === "mixed" ? (
                    <>
                      <Text style={s.lineMeta}>
                        Approved — some items are coming from another engineer&rsquo;s van.
                      </Text>
                      <Button
                        title="View transfer &amp; contact"
                        variant="ghost"
                        small
                        onPress={() =>
                          kr.transferId
                            ? router.push({ pathname: "/transfers/[id]", params: { id: kr.transferId } })
                            : router.push("/(tabs)/requests")
                        }
                      />
                    </>
                  ) : kr.fulfillmentMode === "warehouse_issue" ? (
                    <Text style={s.lineMeta}>Approved — collect from the warehouse.</Text>
                  ) : null
                ) : null}
                {kr.status === "pending" ? (
                  <Button
                    title="Cancel request"
                    variant="secondary"
                    small
                    onPress={() =>
                      void cancelKitRequest(kr.id)
                        .then(() => {
                          toast.success("Request cancelled.");
                          return reloadKitRequests();
                        })
                        .catch(() => toast.error("Could not cancel the request."))
                    }
                  />
                ) : null}
              </Card>
            ))
          )}
        </>
      ) : null}

      <WarehousePickupModal warehouse={pickupWarehouse} onClose={() => setPickupWarehouse(null)} />
    </Screen>
  );
}

const s = StyleSheet.create({
  headerTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  jobNumber: { fontSize: 13, fontWeight: "700", color: colors.accent },
  jobName: { fontSize: 18, fontWeight: "800", color: colors.text },
  badgeRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  hint: { fontSize: 13, color: colors.muted },
  notes: { fontSize: 14, color: colors.text },
  lineTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  lineName: { fontSize: 14, fontWeight: "700", color: colors.text, flex: 1 },
  lineQty: { fontSize: 14, fontWeight: "800", color: colors.text },
  lineMeta: { fontSize: 12, color: colors.muted },
  lineTallies: { fontSize: 12, color: colors.info, fontWeight: "600" },
  crossNote: { fontSize: 12, color: colors.warn, fontWeight: "600" },
  vanSource: { fontSize: 12, color: colors.warn },
  warehouseRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  warehouseLink: { fontSize: 13, fontWeight: "600", color: colors.accent },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  krChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  krChipText: { fontSize: 12, fontWeight: "600" },
  krCode: { fontSize: 13, fontWeight: "700", color: colors.accent },
  krRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  krDate: { fontSize: 12, color: colors.muted },
  krReason: { fontSize: 13, color: colors.text, fontStyle: "italic" },
});
