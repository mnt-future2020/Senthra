import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { getOwnMovements, getOwnOverview } from "@/services/engineer.service";
import { useAuth } from "@/lib/auth";
import { useLoad } from "@/lib/useLoad";
import { useSocketRefresh } from "@/lib/useSocketRefresh";
import { Badge, Card, EmptyState, ErrorText, Button, ListSkeleton, Screen, SectionTitle, Skeleton } from "@/components/ui";
import { colors } from "@/lib/theme";
import { formatDate, signed, timeAgo } from "@/lib/format";
import type { EngineerOverview, EngineerOverviewJob, Movement } from "@/types";

// Engineer dashboard — the field engineer's day at a glance, mirroring the web's
// rebuilt EngineerDashboard: workload stat cards, a "Needs your attention" strip,
// the next jobs by due date, create-verb quick actions and the recent stock feed.

const SUBTITLE = "Your jobs, stock and activity at a glance.";
// The dashboard fans in four socket domains, so one action can emit a burst of
// events — coalesce them into a single refetch this long after the last one.
const REFRESH_DEBOUNCE_MS = 250;
const CAPTION_TICK_MS = 30_000;

const DASH_EVENTS = [
  "job:new",
  "job:accepted",
  "job:rejected",
  "job:updated",
  "job:deleted",
  "goods:issued",
  "goods:returned",
  "goods:updated",
  "engineer:transfer_updated",
  "van_stock_request:updated",
  "kit_request:updated",
];

// ── View-model builders (ported from the web's engineerDashboardModel) ────────

type Tone = "neutral" | "accent" | "amber" | "red";

interface StatCardModel {
  key: string;
  icon: React.ReactNode;
  tone: Tone;
  value: number;
  label: string;
  hint: string;
  hintTone?: "red";
  go: () => void;
}

interface AttentionRowModel {
  key: string;
  icon: React.ReactNode;
  tone: Tone;
  text: string;
  go?: () => void;
}

const plural = (n: number) => (n === 1 ? "" : "s");

const TONE_CHIP: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: colors.mutedSoft, fg: colors.muted },
  accent: { bg: colors.accentSoft, fg: colors.accent },
  amber: { bg: colors.warnSoft, fg: colors.warn },
  red: { bg: colors.dangerSoft, fg: colors.danger },
};

// Matches the web's UTC-day overdue boundary so the row label always agrees
// with the backend's overdue count.
const isPast = (iso: string | null): boolean => {
  if (!iso) return false;
  const due = Date.parse(iso);
  if (Number.isNaN(due)) return false;
  const now = new Date();
  return due < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

function StatCardView({ card }: { card: StatCardModel }) {
  const chip = TONE_CHIP[card.tone];
  return (
    <Card style={s.statCard} onPress={card.go}>
      <View style={[s.statIcon, { backgroundColor: chip.bg }]}>{card.icon}</View>
      <Text style={s.statValue}>{card.value}</Text>
      <Text style={s.statLabel}>{card.label}</Text>
      <Text style={[s.statHint, card.hintTone === "red" && { color: colors.danger }]} numberOfLines={1}>
        {card.hint}
      </Text>
    </Card>
  );
}

function NextUpJobRow({ job, onPress }: { job: EngineerOverviewJob; onPress: () => void }) {
  const overdue = isPast(job.completionDate);
  const urgent = job.priority === "urgent" || job.priority === "high";
  return (
    <Card onPress={onPress}>
      <View style={s.jobTop}>
        <Text style={s.jobNumber}>{job.jobNumber}</Text>
        <Badge status={job.status} />
        {urgent ? (
          <View style={s.urgentPill}>
            <Text style={s.urgentPillText}>{job.priority.toUpperCase()}</Text>
          </View>
        ) : null}
      </View>
      <Text style={s.jobName} numberOfLines={1}>
        {job.name}
      </Text>
      {job.customerName ? (
        <Text style={s.jobCustomer} numberOfLines={1}>
          {job.customerName}
        </Text>
      ) : null}
      <Text style={[s.jobDue, overdue && { color: colors.danger }]}>
        {job.completionDate
          ? overdue
            ? `Overdue · ${formatDate(job.completionDate)}`
            : `Due ${formatDate(job.completionDate)}`
          : "No due date"}
      </Text>
    </Card>
  );
}

export default function OverviewScreen() {
  const router = useRouter();
  const { can } = useAuth();

  // Every deep-link carries a nav nonce so tapping the same card twice still
  // re-seeds the target screen's filters (identical params would otherwise be a
  // no-op because the tab screen stays mounted).
  const link = (pathname: string, p: Record<string, string> = {}) => () =>
    router.push({ pathname, params: { ...p, t: String(Date.now()) } });

  const { data, loading, error, refreshing, refresh, reload } = useLoad(
    useCallback(async () => {
      // One aggregated read + the last few movements (best-effort), like the web.
      const [overview, moves] = await Promise.all([
        getOwnOverview(),
        getOwnMovements({ limit: 6 }).catch(() => ({ movements: [] as Movement[], nextCursor: null, hasMore: false })),
      ]);
      return { overview, recent: moves.movements, updatedAt: new Date().toISOString() };
    }, []),
  );

  // Live-update on every domain the cards aggregate, burst-debounced into one refetch.
  const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useSocketRefresh(DASH_EVENTS, () => {
    if (burstTimer.current) clearTimeout(burstTimer.current);
    burstTimer.current = setTimeout(() => void reload(), REFRESH_DEBOUNCE_MS);
  });
  useEffect(
    () => () => {
      if (burstTimer.current) clearTimeout(burstTimer.current);
    },
    [],
  );

  // Re-render the "Updated X ago" caption on a tick, without refetching.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), CAPTION_TICK_MS);
    return () => clearInterval(t);
  }, []);

  if (loading)
    return (
      <Screen>
        <Skeleton width="55%" height={22} />
        <View style={s.statRow}>
          <Card style={s.statCard}>
            <Skeleton width={30} height={30} radius={10} />
            <Skeleton width="40%" height={24} />
            <Skeleton width="70%" height={11} />
          </Card>
          <Card style={s.statCard}>
            <Skeleton width={30} height={30} radius={10} />
            <Skeleton width="40%" height={24} />
            <Skeleton width="70%" height={11} />
          </Card>
        </View>
        <ListSkeleton count={4} />
      </Screen>
    );

  if (!data)
    return (
      <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
        <ErrorText message={error} />
        <EmptyState title="We couldn't load your dashboard" />
        <Button title="Retry" variant="secondary" onPress={() => void reload()} />
      </Screen>
    );

  const o: EngineerOverview = data.overview;
  const canJobs = can("engineer.jobs.view");
  const canTransfers = can("engineer.transfer");
  const canVanStock = can("engineer.van_stock.request");
  const canInventory = can("engineer.inventory.view");
  const canRequestKit = can("engineer.jobs.request_kit");

  // ── Stat cards (permission-gated, deep-linking, web copy) ──
  const cards: StatCardModel[] = [];
  if (canJobs) {
    cards.push({
      key: "toAccept",
      icon: <Ionicons name="file-tray-full" size={16} color={TONE_CHIP[o.jobs.toAccept > 0 ? "amber" : "neutral"].fg} />,
      tone: o.jobs.toAccept > 0 ? "amber" : "neutral",
      value: o.jobs.toAccept,
      label: "Jobs to accept",
      hint: o.jobs.toAccept > 0 ? "awaiting your response" : "nothing waiting",
      go: link("/(tabs)/jobs", { status: "assigned" }),
    });
    cards.push({
      key: "inProgress",
      icon: <Ionicons name="construct" size={16} color={TONE_CHIP.accent.fg} />,
      tone: "accent",
      value: o.jobs.inProgress,
      label: "In progress",
      hint:
        o.jobs.overdue > 0
          ? `${o.jobs.overdue} overdue`
          : o.jobs.accepted > 0
            ? `${o.jobs.accepted} accepted, not started`
            : o.jobs.dueThisWeek > 0
              ? `${o.jobs.dueThisWeek} due this week`
              : "nothing due this week",
      hintTone: o.jobs.overdue > 0 ? "red" : undefined,
      go: link("/(tabs)/jobs", { status: "in_progress" }),
    });
  }
  if (canVanStock) {
    cards.push({
      key: "vanStock",
      icon: (
        <MaterialCommunityIcons name="truck-outline" size={16} color={TONE_CHIP[o.vanStock.toCollect > 0 ? "accent" : "neutral"].fg} />
      ),
      tone: o.vanStock.toCollect > 0 ? "accent" : "neutral",
      value: o.vanStock.toCollect,
      label: "Field stock to collect",
      hint: o.vanStock.toCollect > 0 ? "ready at a warehouse" : "nothing to collect",
      go: link("/(tabs)/requests", { tab: "van", status: "collectible" }),
    });
  }
  if (canTransfers) {
    cards.push({
      key: "transfers",
      icon: (
        <Ionicons name="swap-horizontal" size={16} color={TONE_CHIP[o.transfers.incomingPending > 0 ? "accent" : "neutral"].fg} />
      ),
      tone: o.transfers.incomingPending > 0 ? "accent" : "neutral",
      value: o.transfers.incomingPending,
      label: "Transfers pending",
      hint: o.transfers.incomingPending > 0 ? "waiting for your acceptance" : "inbox clear",
      go: link("/(tabs)/requests", { tab: "transfers", view: "incoming", status: "pending" }),
    });
  }
  if (canInventory) {
    cards.push({
      key: "stock",
      icon: <Ionicons name="cube" size={16} color={TONE_CHIP.neutral.fg} />,
      tone: "neutral",
      value: o.stock.totalQuantity,
      label: "Stock on hand",
      hint: `${o.stock.lines} item${plural(o.stock.lines)} held${o.misc.lines > 0 ? ` · ${o.misc.lines} misc` : ""}`,
      go: link("/(tabs)/stock", { section: "irm" }),
    });
    cards.push({
      key: "customer",
      icon: <Ionicons name="people" size={16} color={TONE_CHIP.neutral.fg} />,
      tone: "neutral",
      value: o.customerStock.totalQuantity,
      label: "Customer stock",
      hint:
        o.customerStock.lines > 0
          ? `${o.customerStock.lines} item${plural(o.customerStock.lines)} held for customers`
          : "none held",
      go: link("/(tabs)/stock", { section: "customer" }),
    });
  }

  // ── "Needs your attention" rows (only non-zero, actionable signals) ──
  const attention: AttentionRowModel[] = [];
  if (canJobs && o.jobs.toAccept > 0)
    attention.push({
      key: "accept",
      icon: <Ionicons name="file-tray-full" size={16} color={TONE_CHIP.amber.fg} />,
      tone: "amber",
      text: `${o.jobs.toAccept} job${plural(o.jobs.toAccept)} waiting for you to accept or reject`,
      go: link("/(tabs)/jobs", { status: "assigned" }),
    });
  if (canJobs && o.jobs.overdue > 0)
    attention.push({
      key: "overdue",
      icon: <Ionicons name="alert-circle" size={16} color={TONE_CHIP.red.fg} />,
      tone: "red",
      text: `${o.jobs.overdue} active job${o.jobs.overdue === 1 ? " is" : "s are"} past the completion date`,
      go: link("/(tabs)/jobs", { status: "overdue" }),
    });
  if (canVanStock && o.vanStock.toCollect > 0)
    attention.push({
      key: "collect",
      icon: <MaterialCommunityIcons name="truck-outline" size={16} color={TONE_CHIP.accent.fg} />,
      tone: "accent",
      text: `${o.vanStock.toCollect} field-stock request${plural(o.vanStock.toCollect)} ready to collect`,
      go: link("/(tabs)/requests", { tab: "van", status: "collectible" }),
    });
  if (canTransfers && o.transfers.incomingPending > 0)
    attention.push({
      key: "transfers",
      icon: <Ionicons name="swap-horizontal" size={16} color={TONE_CHIP.accent.fg} />,
      tone: "accent",
      text: `${o.transfers.incomingPending} incoming transfer${plural(o.transfers.incomingPending)} to accept`,
      go: link("/(tabs)/requests", { tab: "transfers", view: "incoming", status: "pending" }),
    });
  if (canTransfers && o.transfers.toSign > 0)
    attention.push({
      key: "sign",
      icon: <Ionicons name="swap-horizontal" size={16} color={TONE_CHIP.amber.fg} />,
      tone: "amber",
      text: `${o.transfers.toSign} delivered transfer${plural(o.transfers.toSign)} awaiting your signature`,
      go: link("/(tabs)/requests", { tab: "transfers", view: "outgoing", status: "" }),
    });
  if (canRequestKit && o.kitRequests.pending > 0)
    // Informational (no link): kit requests are raised + tracked inside each job's
    // detail page and only the planner can action a pending one.
    attention.push({
      key: "kit",
      icon: <Ionicons name="build" size={16} color={TONE_CHIP.accent.fg} />,
      tone: "accent",
      text: `${o.kitRequests.pending} kit request${plural(o.kitRequests.pending)} awaiting the planner`,
    });

  // ── Quick actions — the engineer's CREATE verbs, permission-gated ──
  const actions: { label: string; icon: React.ReactNode; go: () => void }[] = [];
  if (canVanStock) {
    actions.push({
      label: "Request field stock",
      icon: <MaterialCommunityIcons name="truck-outline" size={20} color={colors.accent} />,
      go: () => router.push("/van-stock/new"),
    });
    actions.push({
      label: "Return stock",
      icon: <Ionicons name="return-down-back" size={20} color={colors.accent} />,
      go: () => router.push("/van-stock/return"),
    });
  }
  if (canTransfers) {
    actions.push({
      label: "Request transfer",
      icon: <Ionicons name="swap-horizontal" size={20} color={colors.accent} />,
      go: () => router.push("/transfers/new"),
    });
  }

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <View style={s.headerRow}>
        <Text style={s.subtitle}>{SUBTITLE}</Text>
        <Pressable style={s.updatedRow} onPress={() => void reload()} hitSlop={8}>
          <Text style={s.updatedText}>Updated {timeAgo(data.updatedAt)}</Text>
          <Ionicons name="refresh" size={13} color={colors.faint} />
        </Pressable>
      </View>
      <ErrorText message={error} />

      <View style={s.statRow}>
        {cards.map((c) => (
          <StatCardView key={c.key} card={c} />
        ))}
      </View>

      {attention.length > 0 ? (
        <>
          <SectionTitle>Needs your attention</SectionTitle>
          <Card>
            {attention.map((r, i) => {
              const chip = TONE_CHIP[r.tone];
              const inner = (
                <View style={[s.attentionRow, i > 0 && s.attentionRowBorder]}>
                  <View style={[s.attentionIcon, { backgroundColor: chip.bg }]}>{r.icon}</View>
                  <Text style={s.attentionText}>{r.text}</Text>
                  {r.go ? <Ionicons name="chevron-forward" size={16} color={colors.faint} /> : null}
                </View>
              );
              return r.go ? (
                <Pressable key={r.key} onPress={r.go}>
                  {inner}
                </Pressable>
              ) : (
                <View key={r.key}>{inner}</View>
              );
            })}
          </Card>
        </>
      ) : null}

      <View style={s.sectionHeaderRow}>
        <View style={s.flex1}>
          <SectionTitle>Next up</SectionTitle>
          <Text style={s.sectionCaption}>Your active jobs, soonest due first.</Text>
        </View>
        {canJobs ? (
          <Pressable onPress={link("/(tabs)/jobs", { status: "" })} hitSlop={8}>
            <Text style={s.linkText}>All jobs →</Text>
          </Pressable>
        ) : null}
      </View>
      {!canJobs ? (
        <EmptyState
          title="Jobs aren't part of your access"
          subtitle="Ask an administrator if you should be able to see your assigned jobs here."
        />
      ) : o.jobs.next.length === 0 ? (
        <EmptyState title="No active jobs" subtitle="New assignments will appear here the moment they land." />
      ) : (
        o.jobs.next.map((j) => (
          <NextUpJobRow key={j.id} job={j} onPress={() => router.push({ pathname: "/jobs/[id]", params: { id: j.id } })} />
        ))
      )}

      {actions.length > 0 ? (
        <>
          <SectionTitle>Quick actions</SectionTitle>
          <View style={s.actionsGrid}>
            {actions.map((a) => (
              <Card key={a.label} style={s.action} onPress={a.go}>
                {a.icon}
                <Text style={s.actionText}>{a.label}</Text>
              </Card>
            ))}
          </View>
        </>
      ) : null}

      <View style={s.sectionHeaderRow}>
        <View style={s.flex1}>
          <SectionTitle>Recent activity</SectionTitle>
        </View>
        <Pressable onPress={link("/(tabs)/stock", { section: "movements" })} hitSlop={8}>
          <Text style={s.linkText}>View all →</Text>
        </Pressable>
      </View>
      {data.recent.length === 0 ? (
        <EmptyState title="No activity yet" subtitle="When you collect, use or transfer stock, it'll show here." />
      ) : (
        data.recent.map((a) => (
          <Card key={a.id}>
            <View style={s.activityRow}>
              <View style={s.activityMain}>
                <Text style={s.activityTitle} numberOfLines={1}>
                  {a.label} · {a.itemName}
                </Text>
                <Text style={s.activityMeta} numberOfLines={1}>
                  {a.itemCode || (a.ownership === "customer" ? "Customer" : "")}
                  {a.reference ? ` · ${a.reference}` : ""}
                </Text>
              </View>
              <View style={s.activityRight}>
                <Text style={[s.activityQty, { color: a.quantityDelta >= 0 ? colors.success : colors.danger }]}>
                  {signed(a.quantityDelta)}
                </Text>
                <Text style={s.activityMeta}>{formatDate(a.date)}</Text>
              </View>
            </View>
          </Card>
        ))
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  flex1: { flex: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  subtitle: { fontSize: 13, color: colors.muted, flex: 1 },
  updatedRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  updatedText: { fontSize: 11, color: colors.faint },
  statRow: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  statCard: { flexBasis: "47%", flexGrow: 1, gap: 4 },
  statIcon: { width: 30, height: 30, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  statValue: { fontSize: 24, fontWeight: "800", color: colors.text },
  statLabel: { fontSize: 13, fontWeight: "700", color: colors.text },
  statHint: { fontSize: 11, color: colors.muted },
  attentionRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9 },
  attentionRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  attentionIcon: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  attentionText: { flex: 1, fontSize: 13, fontWeight: "600", color: colors.text },
  sectionHeaderRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: 10 },
  sectionCaption: { fontSize: 12, color: colors.muted, marginTop: 2 },
  linkText: { fontSize: 12, fontWeight: "700", color: colors.accent },
  jobTop: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  jobNumber: { fontSize: 12, fontWeight: "700", color: colors.muted },
  urgentPill: { backgroundColor: colors.dangerSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  urgentPillText: { fontSize: 10, fontWeight: "800", color: colors.danger, letterSpacing: 0.5 },
  jobName: { fontSize: 14, fontWeight: "700", color: colors.text },
  jobCustomer: { fontSize: 11, color: colors.faint },
  jobDue: { fontSize: 12, fontWeight: "700", color: colors.muted },
  actionsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  action: { flexBasis: "47%", flexGrow: 1, alignItems: "flex-start", gap: 6, paddingVertical: 16 },
  actionText: { fontSize: 14, fontWeight: "600", color: colors.text },
  activityRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  activityMain: { flex: 1, gap: 2 },
  activityRight: { alignItems: "flex-end", gap: 2 },
  activityTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  activityMeta: { fontSize: 11, color: colors.faint },
  activityQty: { fontSize: 15, fontWeight: "800" },
});
