import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import {
  acceptOwnJob,
  getOwnJob,
  rejectOwnJob,
  startOwnJob,
} from "@/services/engineer.service";
import { cancelKitRequest, listMyKitRequests } from "@/services/kitRequest.service";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLoad } from "@/lib/useLoad";
import { useSocketRefresh } from "@/lib/useSocketRefresh";
import { useToast } from "@/lib/toast";
import {
  crossWarehouseReturnNote,
  GOODS_STATUS_LABELS,
  kitLineOutcome,
  kitLineSourceSplit,
  LINE_TYPE_LABEL,
  outstandingKit,
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
import { formatDate, formatDateTime, formatHireDate, joinAddress, titleCase } from "@/lib/format";
import type { JobKitLine, JobKitWarehouse, KitRequest, KitRequestLine } from "@/types";

function KitLineCard({
  line,
  lines,
  jobCancelled,
  onWarehousePress,
}: {
  line: JobKitLine;
  lines: JobKitLine[];
  jobCancelled: boolean;
  onWarehousePress: (w: JobKitWarehouse) => void;
}) {
  const crossNote = crossWarehouseReturnNote(line, lines);
  // A line MERGES origins: some units collected from its warehouse, some handed over from another
  // engineer's van. Show each with its quantity — how many to collect vs how many are coming to you.
  // The warehouse chip shows its whole SHARE (issued from it + still to collect), so a freshly split
  // line with nothing issued yet still names its pickup. When the van covers everything, the link is
  // suppressed: it stores the RETURN warehouse, not a pickup.
  const hasVanSources = line.vanSources.length > 0;
  const split = kitLineSourceSplit(line, { jobCancelled });
  const showWarehouse = !hasVanSources || split.warehouseShare > 0;
  const returnNote = hasVanSources ? returnLocationNote(line, split) : "";
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
        {/* A rental line has no customer SE code, but it does have the RNT-#### printed on the case —
            which is what the engineer matches against the sticker and the warehouse types into the
            scan box. Same slot as seCode, exactly as the web renders it. */}
        {line.seCode
          ? ` · ${line.seCode}`
          : line.lineType === "rental" && line.rentalItemCode
            ? ` · ${line.rentalItemCode}`
            : ""}
      </Text>
      {/* The hire's return deadline. RENTAL lines only, and only while units are still out — the
          server nulls it otherwise. `hireOverdue` is resolved server-side against the COMPANY
          timezone; never recompute it here from the date (see the note on JobKitLine). */}
      {line.hireEndDate ? (
        <View style={s.hireRow}>
          <MaterialCommunityIcons
            name="calendar-clock"
            size={14}
            color={line.hireOverdue ? colors.danger : colors.muted}
          />
          <Text style={[s.hireText, line.hireOverdue && s.hireTextOverdue]}>
            {/* formatHireDate, NOT formatDate — see lib/format.ts. The deadline is a calendar day. */}
            {line.hireOverdue
              ? `Was due back ${formatHireDate(line.hireEndDate)} — overdue`
              : `Return by ${formatHireDate(line.hireEndDate)}`}
          </Text>
        </View>
      ) : null}
      {showWarehouse && line.warehouse ? (
        <Pressable style={s.warehouseRow} onPress={() => onWarehousePress(line.warehouse!)}>
          <Ionicons name="location" size={14} color={colors.accent} />
          <Text style={s.warehouseLink}>
            {line.warehouse.name}
            {line.warehouse.code ? ` (${line.warehouse.code})` : ""}
            {hasVanSources ? ` ×${split.warehouseShare}` : ""}
          </Text>
        </Pressable>
      ) : showWarehouse && line.warehouseName ? (
        <Text style={s.lineMeta}>
          {line.warehouseName}
          {line.warehouseCode ? ` (${line.warehouseCode})` : ""}
          {hasVanSources ? ` ×${split.warehouseShare}` : ""}
        </Text>
      ) : null}
      {split.outstandingWarehouseQty > 0 && split.warehouseQty > 0 ? (
        <Text style={s.toCollect}>{split.outstandingWarehouseQty} to collect</Text>
      ) : null}
      {/* Misc is free text with no barcode and no stock balance: never scanned
          back, left out of Complete, skipped by reconcile — so Used/Returned/
          Remaining would sit at 0/0/issued forever. An em dash says the column
          doesn't apply (web parity). */}
      <Text style={s.lineTallies}>
        Issued {line.issued} · Used{" "}
        {/* A hire is never consumed — every unit goes back to the provider — so "Used" has no
            meaning on a rental line, exactly as it has none on a free-text misc line. */}
        {line.lineType === "misc" || line.lineType === "rental" ? "—" : line.used} · Returned{" "}
        {line.lineType === "misc" ? "—" : line.returned} · On van{" "}
        {line.lineType === "misc" ? "—" : line.remaining}
      </Text>
      {crossNote ? <Text style={s.crossNote}>{crossNote}</Text> : null}
      {line.vanSources.length > 0 ? (
        <>
          {line.vanSources.map((v, i) => (
            <View key={`${v.transferCode}-${i}`} style={s.vanSourceRow}>
              <Text style={s.vanSource}>From van: </Text>
              {v.engineerPhone ? (
                <Pressable onPress={() => void Linking.openURL(`tel:${v.engineerPhone}`)}>
                  <Text style={s.vanSourcePhone}>{v.engineerName}</Text>
                </Pressable>
              ) : (
                <Text style={s.vanSource}>{v.engineerName}</Text>
              )}
              <Text style={s.vanSource}>
                {" "}×{v.quantity}
                {v.status === "pending" ? " · awaiting handover" : ""}
              </Text>
            </View>
          ))}
          {returnNote ? <Text style={s.lineMeta}>{returnNote}</Text> : null}
        </>
      ) : null}
      {line.notes ? <Text style={s.lineMeta}>Notes: {line.notes}</Text> : null}
    </Card>
  );
}

/**
 * Kit-request lines with the reviewer's per-line outcome, mirroring the web's
 * KitRequestLines: an excluded line is struck through showing the ASKED qty
 * with a "Not approved" pill; a trimmed line shows the granted qty plus
 * "of N asked".
 */
function KitRequestLines({ lines }: { lines: KitRequestLine[] }) {
  if (lines.length === 0) return null;
  return (
    <View style={s.krLines}>
      {lines.map((l) => {
        const o = kitLineOutcome(l);
        return (
          <View key={l.id} style={[s.krLine, o.excluded && s.krLineExcluded]}>
            <View style={s.krLineMain}>
              <View style={s.krLineTop}>
                <Text style={[s.krLineName, o.excluded && s.krStruck]} numberOfLines={1}>
                  {l.itemName}
                </Text>
                {l.source === "customer_stock" ? (
                  <View style={[s.krPill, { backgroundColor: colors.accentSoft }]}>
                    <Text style={[s.krPillText, { color: colors.accent }]}>Customer stock</Text>
                  </View>
                ) : null}
                {/* Rental needs its own pill, not the IRM blank: it is the one pool collected from a
                    specific depot's live hire, never off a van, and owed back to a provider. */}
                {l.source === "rental" ? (
                  <View style={[s.krPill, { backgroundColor: colors.warnSoft }]}>
                    <Text style={[s.krPillText, { color: colors.warn }]}>Rental</Text>
                  </View>
                ) : null}
                {l.source === "misc" ? (
                  <View style={[s.krPill, { backgroundColor: colors.mutedSoft }]}>
                    <Text style={[s.krPillText, { color: colors.muted }]}>Misc</Text>
                  </View>
                ) : null}
                {o.excluded ? (
                  <View style={[s.krPill, { backgroundColor: colors.dangerSoft }]}>
                    <Text style={[s.krPillText, { color: colors.danger }]}>Not approved</Text>
                  </View>
                ) : null}
              </View>
              {/* The depot a rental was sourced from reads the same way as a consignment's location —
                  both answer "where does the engineer collect this". */}
              {(l.source === "customer_stock" || l.source === "rental") && l.warehouseName ? (
                <Text style={s.krWarehouse}>
                  {l.warehouseName}
                  {l.warehouseCode ? ` (${l.warehouseCode})` : ""}
                </Text>
              ) : null}
            </View>
            <Text style={s.krQty}>
              {o.excluded ? (
                <Text style={s.krStruck}>×{l.qty}</Text>
              ) : (
                <>
                  ×{o.qty}
                  {o.trimmed ? <Text style={s.krAsked}> of {l.qty} asked</Text> : null}
                </>
              )}
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
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [pickupWarehouse, setPickupWarehouse] = useState<JobKitWarehouse | null>(null);

  const { data: job, setData: setJob, loading, refreshing, error, refresh } = useLoad(
    useCallback(() => getOwnJob(id), [id]),
  );
  const { data: kitRequests, error: kitError, reload: reloadKitRequests } = useLoad(
    useCallback(() => listMyKitRequests({ jobId: id, pageSize: 50 }).then((r) => r.requests), [id]),
  );

  useSocketRefresh(["kit_request:updated"], () => void reloadKitRequests());

  // Live-refresh the job so kit tallies + the "Start work" gate never go stale
  // (warehouse issues kit, planner edits/cancels/reassigns). Skipped while one of
  // this screen's own mutations is in flight — that action already replaces state
  // from its response, so a socket refetch can't race it. Mirrors the web detail.
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  });
  useSocketRefresh(
    ["job:new", "job:accepted", "job:rejected", "job:updated", "job:deleted", "goods:issued", "goods:returned", "goods:updated", "engineer:transfer_updated"],
    () => {
      if (busyRef.current) return;
      getOwnJob(id)
        .then(setJob)
        .catch((e) => {
          // Only a genuine stale-state error (404/409 — reassigned or cancelled out
          // from under this engineer) is worth interrupting for; transient network
          // blips are swallowed, leaving the current job on screen.
          if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
            toast.error("This job is no longer available — it may have been reassigned or cancelled.");
          }
        });
    },
  );

  const run = async (key: string, fn: () => Promise<typeof job>, successMsg: string, failMsg: string) => {
    setBusy(key);
    try {
      const next = await fn();
      if (next) setJob(next);
      setRejecting(false);
      toast.success(successMsg);
    } catch (err) {
      // Toast the server's reason (e.g. "This job can't be started right now.") —
      // a generic message would hide what the engineer should do next.
      toast.error(err instanceof Error ? err.message : failMsg);
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

  // Web parity: cancelling a kit request asks for confirmation first.
  const confirmCancelKitRequest = (krId: string) => {
    Alert.alert(
      "Cancel this kit request?",
      "The planner will no longer see this request. This can't be undone.",
      [
        { text: "Keep it", style: "cancel" },
        {
          text: "Cancel request",
          style: "destructive",
          onPress: () =>
            void cancelKitRequest(krId)
              .then(() => {
                toast.success("Kit request cancelled.");
                return reloadKitRequests();
              })
              .catch(() => toast.error("Could not cancel the request.")),
        },
      ],
    );
  };

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

      {job.status === "assigned" ? (
        <Card>
          <SectionTitle>{rejecting ? "Reject this job" : "Respond to assignment"}</SectionTitle>
          <Button
            title="Accept job"
            onPress={() =>
              void run("accept", () => acceptOwnJob(job.id), "Job accepted.", "Could not accept this job.")
            }
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
                    "Could not reject this job.",
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
            onPress={() =>
              void run("start", () => startOwnJob(job.id), "Job started. You are now on site.", "Could not start this job.")
            }
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
        {/* When the office raised the job. The web keeps this in its own "Record" card; this screen
            folded that card away and lost the row with it. It leads the section because it is the
            earliest event — the rest of these read as a timeline from here. */}
        <InfoRow label="Created" value={formatDate(job.createdAt)} />
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
      {(() => {
        // Web parity: a cancelled job with stock still on the van gets a return
        // advisory — nothing more is to be collected.
        const held = outstandingKit(job.kitLines);
        return job.status === "cancelled" && held.units > 0 ? (
          <Card style={s.warnCard}>
            <Text style={s.warnText}>
              This job was cancelled. Return the {held.units} unit{held.units === 1 ? "" : "s"}{" "}
              you&rsquo;re still holding to the warehouse — nothing more is to be collected.
            </Text>
          </Card>
        ) : null;
      })()}
      {job.kitLines.length === 0 ? (
        <EmptyState title="No kit lines on this job" />
      ) : (
        job.kitLines.map((line) => (
          <KitLineCard
            key={line.id}
            line={line}
            lines={job.kitLines}
            jobCancelled={job.status === "cancelled"}
            onWarehousePress={setPickupWarehouse}
          />
        ))
      )}

      {showKitCard ? (
        <>
          <SectionTitle>Additional kit</SectionTitle>
          <Text style={s.hint}>
            Need more? Request extra units of a planned item or a new item — the planner reviews and
            issues it.
          </Text>
          {kitLocked ? (
            <Text style={s.hint}>Goods reconciled — kit locked, no more requests.</Text>
          ) : (
            <Button title="Request items" variant="secondary" onPress={openKitRequest} />
          )}
          {kitError ? (
            <ErrorText message={kitError} />
          ) : (kitRequests ?? []).length === 0 ? (
            <EmptyState
              title="No kit requests yet"
              subtitle="Need more kit? Use &ldquo;Request items&rdquo; above and it&rsquo;ll show here."
            />
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
                <KitRequestLines lines={kr.lines} />
                {kr.reason ? <Text style={s.krReason}>&ldquo;{kr.reason}&rdquo;</Text> : null}
                {kr.status === "declined" && kr.decisionNote ? (
                  <Text style={s.lineMeta}>Planner: {kr.decisionNote}</Text>
                ) : null}
                {kr.status === "approved" ? (
                  kr.fulfillmentMode === "engineer_transfer" || kr.fulfillmentMode === "mixed" ? (
                    <>
                      <Text style={s.lineMeta}>
                        {kr.fulfillmentMode === "mixed"
                          ? "Approved — some items come from another engineer, the rest from the warehouse."
                          : "Approved — coming via an engineer transfer."}
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
                    onPress={() => confirmCancelKitRequest(kr.id)}
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
  toCollect: { fontSize: 12, color: colors.warn, fontWeight: "700" },
  vanSourceRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
  vanSource: { fontSize: 12, color: colors.warn },
  vanSourcePhone: { fontSize: 12, color: colors.accent, fontWeight: "600" },
  warehouseRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  hireRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  hireText: { fontSize: 12, fontWeight: "600", color: colors.muted },
  hireTextOverdue: { color: colors.danger, fontWeight: "700" },
  warehouseLink: { fontSize: 13, fontWeight: "600", color: colors.accent },
  warnCard: { borderColor: colors.warn, backgroundColor: colors.warnSoft },
  warnText: { fontSize: 13, color: colors.warn },
  krLines: { gap: 6 },
  krLine: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  krLineExcluded: { opacity: 0.6 },
  krLineMain: { flex: 1, gap: 2 },
  krLineTop: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  krLineName: { fontSize: 13, fontWeight: "700", color: colors.text, flexShrink: 1 },
  krStruck: { textDecorationLine: "line-through", color: colors.muted },
  krPill: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  krPillText: { fontSize: 9, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  krWarehouse: { fontSize: 11, color: colors.muted },
  krQty: { fontSize: 13, fontWeight: "700", color: colors.text },
  krAsked: { fontSize: 11, fontWeight: "400", color: colors.faint },
  krCode: { fontSize: 13, fontWeight: "700", color: colors.accent },
  krRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  krDate: { fontSize: 12, color: colors.muted },
  krReason: { fontSize: 13, color: colors.text, fontStyle: "italic" },
});
