import React, { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { listMyTransfers } from "@/services/transfer.service";
import {
  cancelVanStockRemaining,
  cancelVanStockRequest,
  listMyVanStockRequests,
} from "@/services/vanStock.service";
import { listMyKitRequests } from "@/services/kitRequest.service";
import { useLoad } from "@/lib/useLoad";
import { useDebounced } from "@/lib/useDebounced";
import { useSocketRefresh } from "@/lib/useSocketRefresh";
import { useToast } from "@/lib/toast";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  FilterRow,
  Input,
  ListFade,
  ListSkeleton,
  Pager,
  Screen,
  Segmented,
  Select,
} from "@/components/ui";
import { colors } from "@/lib/theme";
import { formatDateTime, timeAgo, titleCase } from "@/lib/format";
import { kitLineOutcome } from "@/lib/jobKit";
import type { EngineerTransfer, VanStockRequest } from "@/types";

const TABS = [
  { key: "transfers", label: "Transfers" },
  { key: "van", label: "Field Stock" },
  { key: "kit", label: "Kit" },
];

const PAGE_SIZE = 20;

const TRANSFER_VIEWS = [
  { key: "incoming", label: "Incoming" },
  { key: "outgoing", label: "My requests" },
];

const TRANSFER_STATUS_FILTERS = [
  { key: "", label: "All statuses" },
  { key: "pending", label: "Pending" },
  { key: "completed", label: "Completed" },
  { key: "declined", label: "Declined" },
  { key: "cancelled", label: "Cancelled" },
];

const VSR_STATUS_FILTERS = [
  { key: "", label: "All statuses" },
  { key: "pending", label: "Pending" },
  // Composite of approved + partially_fulfilled — the two states with stock still to pick up.
  { key: "collectible", label: "Ready to collect" },
  { key: "approved", label: "Approved" },
  { key: "partially_fulfilled", label: "Partially fulfilled" },
  { key: "fulfilled", label: "Fulfilled" },
  { key: "declined", label: "Declined" },
  { key: "cancelled", label: "Cancelled" },
];

const VSR_TYPE_FILTERS = [
  { key: "", label: "All types" },
  { key: "restock", label: "Restock" },
  { key: "return", label: "Return" },
];

const VSR_ORIGIN_FILTERS = [
  { key: "", label: "All origins" },
  { key: "engineer_request", label: "My requests" },
  { key: "walk_in", label: "Walk-ins" },
];

const SORT_OPTIONS = [
  { key: "", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
];

const VSR_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  partially_fulfilled: "Partially fulfilled",
  fulfilled: "Fulfilled",
  declined: "Declined",
  cancelled: "Cancelled",
};

/** Web's VanRequestItemsSummary: up to 3 items — "Item ×2 • Other ×1 • +3 more". */
function itemsSummary(r: VanStockRequest): string {
  const parts = r.lines.slice(0, 3).map((l) => `${l.itemName} ×${l.requestedQty}`);
  const more = r.lines.length - 3;
  return parts.join(" • ") + (more > 0 ? ` • +${more} more` : "");
}

/** Web's VanStockCompletionBadge: how a closed request ended, if not cleanly. */
function completionBadge(r: VanStockRequest): { label: string; status: string } | null {
  if (r.completionType !== "cancelled_remaining" && r.completionType !== "closed_short") return null;
  const collectedSome = r.lines.some((l) => l.fulfilledQty > 0);
  if (r.completionType === "cancelled_remaining") {
    return { label: collectedSome ? "Rest cancelled" : "Cancelled", status: "cancelled" };
  }
  return { label: collectedSome ? "Rest closed short" : "Closed short", status: "high" };
}

/** Approved or partly fulfilled — the states with an unfulfilled remainder to cancel. */
function hasRemainder(r: VanStockRequest): boolean {
  return r.status === "approved" || r.status === "partially_fulfilled";
}

function transferNeedsSign(t: EngineerTransfer): boolean {
  return t.status === "completed" && t.requireSignature && !t.acknowledgedAt;
}

export default function RequestsScreen() {
  const router = useRouter();
  const toast = useToast();
  const params = useLocalSearchParams<{ tab?: string; view?: string; status?: string; t?: string }>();
  const [tab, setTab] = useState("transfers");

  // ── Transfers ───────────────────────────────────────────────────────────────
  const [tView, setTView] = useState("incoming");
  const [tStatus, setTStatus] = useState("");
  const [tSort, setTSort] = useState("");
  const [tQ, setTQ] = useState("");
  const tQuery = useDebounced(tQ);
  const [transferPage, setTransferPage] = useState(1);

  const { data: transfers, loading: l1, fetching: f1, refreshing, error, refresh, reload: reloadTransfers } = useLoad(
    useCallback(async () => {
      const r = await listMyTransfers({
        role: tView as "incoming" | "outgoing",
        status: tStatus || undefined,
        sort: tSort ? "oldest" : undefined,
        search: tQuery || undefined,
        page: transferPage,
        pageSize: PAGE_SIZE,
      });
      if (r.totalPages > 0 && transferPage > r.totalPages) setTransferPage(r.totalPages);
      return r;
    }, [tView, tStatus, tSort, tQuery, transferPage]),
  );

  // ── Field stock ─────────────────────────────────────────────────────────────
  const [vStatus, setVStatus] = useState("");
  const [vType, setVType] = useState("");
  const [vOrigin, setVOrigin] = useState("");
  const [vSort, setVSort] = useState("");
  const [vQ, setVQ] = useState("");
  const vQuery = useDebounced(vQ);
  const [vanPage, setVanPage] = useState(1);

  const { data: vanRequests, loading: l2, fetching: f2, refreshing: vanRefreshing, error: vanError, refresh: refreshVan, reload: reloadVan } = useLoad(
    useCallback(async () => {
      const r = await listMyVanStockRequests({
        status: vStatus || undefined,
        type: vType || undefined,
        createdVia: vOrigin || undefined,
        search: vQuery || undefined,
        sort: vSort ? "oldest" : undefined,
        page: vanPage,
        pageSize: PAGE_SIZE,
      });
      if (r.totalPages > 0 && vanPage > r.totalPages) setVanPage(r.totalPages);
      return r;
    }, [vStatus, vType, vOrigin, vSort, vQuery, vanPage]),
  );

  // ── Kit (mobile-only cross-job list; web shows kit requests per job) ────────
  const [kitPage, setKitPage] = useState(1);
  const { data: kitRequests, loading: l3, fetching: f3, refreshing: kitRefreshing, error: kitError, refresh: refreshKit, reload: reloadKit } = useLoad(
    useCallback(async () => {
      const r = await listMyKitRequests({ page: kitPage, pageSize: PAGE_SIZE });
      if (r.totalPages > 0 && kitPage > r.totalPages) setKitPage(r.totalPages);
      return r;
    }, [kitPage]),
  );

  // Dashboard deep-links: /(tabs)/requests?tab=van&status=collectible or
  // ?tab=transfers&view=incoming&status=pending seed the segment + filters.
  useEffect(() => {
    const tabParam = params.tab;
    if (typeof tabParam !== "string" || !tabParam) return;
    if (!TABS.some((t) => t.key === tabParam)) return;
    const view = params.view;
    const status = params.status;
    const t = setTimeout(() => {
      setTab(tabParam);
      if (tabParam === "van") {
        if (typeof status === "string") setVStatus(status);
        setVanPage(1);
      } else if (tabParam === "transfers") {
        if (typeof view === "string") setTView(view);
        if (typeof status === "string") setTStatus(status);
        setTransferPage(1);
      }
    }, 0);
    return () => clearTimeout(t);
  }, [params.tab, params.view, params.status, params.t]);

  // Narrow subscription (like the web): only the transfer event refetches this
  // list — an unrelated warehouse issue/return doesn't trigger a paged refetch.
  useSocketRefresh(["engineer:transfer_updated"], () => void reloadTransfers());
  useSocketRefresh(["van_stock_request:updated"], () => void reloadVan());
  useSocketRefresh(["kit_request:updated"], () => void reloadKit());

  const confirmVanAction = (r: VanStockRequest) => {
    const remaining = hasRemainder(r);
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
          onPress: () => {
            void (remaining ? cancelVanStockRemaining(r.id) : cancelVanStockRequest(r.id))
              .then(() => {
                toast.success(remaining ? "Remaining quantity cancelled." : "Request cancelled.");
                return reloadVan();
              })
              .catch((err) =>
                toast.error(err instanceof Error ? err.message : "Could not cancel the request."),
              );
          },
        },
      ],
    );
  };

  // Pull-to-refresh targets whichever tab is on screen.
  const refreshingNow = tab === "van" ? vanRefreshing : tab === "kit" ? kitRefreshing : refreshing;
  const onRefresh = () => {
    if (tab === "van") void refreshVan();
    else if (tab === "kit") void refreshKit();
    else void refresh();
  };

  const tFiltered = Boolean(tStatus || tQuery);
  const signPending = (transfers?.transfers ?? []).filter(
    (t) => tView === "outgoing" && transferNeedsSign(t),
  );

  return (
    <Screen refreshing={refreshingNow} onRefresh={onRefresh}>
      <Segmented options={TABS} value={tab} onChange={setTab} />

      {tab === "transfers" && l1 ? <ListSkeleton /> : null}
      {tab === "transfers" && !l1 ? (
        <>
          <Button title="Request stock" variant="secondary" onPress={() => router.push("/transfers/new")} />
          <Segmented
            options={TRANSFER_VIEWS}
            value={tView}
            onChange={(key) => {
              setTView(key);
              setTransferPage(1);
            }}
          />
          {signPending.map((t) => (
            <Card key={`sign-${t.id}`} style={s.signBanner}>
              <Text style={s.signTitle}>Awaiting your signature — {t.code}</Text>
              <Text style={s.meta}>
                From {t.fromEngineerName}
                {t.fromEngineerPhone ? ` · ${t.fromEngineerPhone}` : ""}. Sign to acknowledge receipt of
                the transferred stock.
              </Text>
              <Button
                title="Sign to acknowledge"
                small
                onPress={() => router.push({ pathname: "/transfers/sign", params: { id: t.id } })}
              />
            </Card>
          ))}
          <Input
            placeholder="Search code or reason…"
            value={tQ}
            onChangeText={(v) => {
              setTQ(v);
              setTransferPage(1);
            }}
            autoCapitalize="none"
            returnKeyType="search"
          />
          <FilterRow>
            <Select
              options={TRANSFER_STATUS_FILTERS}
              value={tStatus}
              onChange={(key) => {
                setTStatus(key);
                setTransferPage(1);
              }}
            />
            <Select
              options={SORT_OPTIONS}
              value={tSort}
              onChange={(key) => {
                setTSort(key);
                setTransferPage(1);
              }}
            />
          </FilterRow>
          {/* A load failure gets its own state — never rendered as an empty inbox. */}
          {error ? (
            <ErrorText message={error} />
          ) : (
          <ListFade dimmed={f1}>
            {(transfers?.transfers ?? []).length === 0 ? (
              tFiltered ? (
                <EmptyState title="No matching transfers" subtitle="Try a different search or status filter." />
              ) : tView === "incoming" ? (
                <EmptyState
                  title="No incoming requests"
                  subtitle="When another engineer requests stock from you, it will appear here."
                />
              ) : (
                <EmptyState title="No outgoing requests" subtitle="Requests you've sent will appear here." />
              )
            ) : (
              (transfers?.transfers ?? []).map((t) => (
                <Card key={t.id} onPress={() => router.push({ pathname: "/transfers/[id]", params: { id: t.id } })}>
                  <View style={s.rowTop}>
                    <Text style={s.code}>
                      {t.code} <Text style={s.age}>· {timeAgo(t.createdAt)}</Text>
                    </Text>
                    <View style={s.badgeRow}>
                      {transferNeedsSign(t) && tView === "outgoing" ? (
                        <View style={s.signPill}>
                          <Text style={s.signPillText}>Sign</Text>
                        </View>
                      ) : null}
                      <Badge status={t.status} />
                    </View>
                  </View>
                  {tView === "incoming" ? (
                    <Text style={s.title} numberOfLines={1}>
                      Requested by {t.toEngineerName}
                    </Text>
                  ) : (
                    <Pressable
                      onPress={
                        t.fromEngineerPhone
                          ? () => void Linking.openURL(`tel:${t.fromEngineerPhone}`)
                          : undefined
                      }
                    >
                      <Text style={s.title} numberOfLines={1}>
                        From {t.fromEngineerName}
                        {t.fromEngineerPhone ? <Text style={s.phone}> · {t.fromEngineerPhone}</Text> : null}
                      </Text>
                    </Pressable>
                  )}
                  <Text style={s.meta} numberOfLines={2}>
                    {t.reason}
                  </Text>
                </Card>
              ))
            )}
            {transfers ? (
              <Pager
                page={transfers.page}
                totalPages={transfers.totalPages}
                onPage={setTransferPage}
                total={transfers.total}
                label="transfers"
              />
            ) : null}
          </ListFade>
          )}
        </>
      ) : null}

      {tab === "van" && l2 ? <ListSkeleton /> : null}
      {tab === "van" && !l2 ? (
        <>
          <View style={s.buttonRow}>
            <Button title="Request stock" variant="secondary" small style={s.flex1} onPress={() => router.push("/van-stock/new")} />
            <Button title="Return stock" variant="secondary" small style={s.flex1} onPress={() => router.push("/van-stock/return")} />
          </View>
          <Input
            placeholder="Search code, item or reason…"
            value={vQ}
            onChangeText={(v) => {
              setVQ(v);
              setVanPage(1);
            }}
            autoCapitalize="none"
            returnKeyType="search"
          />
          <FilterRow>
            <Select
              options={VSR_STATUS_FILTERS}
              value={vStatus}
              onChange={(key) => {
                setVStatus(key);
                setVanPage(1);
              }}
            />
            <Select
              options={VSR_TYPE_FILTERS}
              value={vType}
              onChange={(key) => {
                setVType(key);
                setVanPage(1);
              }}
            />
          </FilterRow>
          <FilterRow>
            <Select
              options={VSR_ORIGIN_FILTERS}
              value={vOrigin}
              onChange={(key) => {
                setVOrigin(key);
                setVanPage(1);
              }}
            />
            <Select
              options={SORT_OPTIONS}
              value={vSort}
              onChange={(key) => {
                setVSort(key);
                setVanPage(1);
              }}
            />
          </FilterRow>
          {vanError ? (
            <ErrorText message={vanError} />
          ) : (
          <ListFade dimmed={f2}>
            {(vanRequests?.requests ?? []).length === 0 ? (
              <EmptyState
                title="No field stock requests yet"
                subtitle="Raise a restock when your consumables run low, or return excess stock to a warehouse."
              />
            ) : (
              (vanRequests?.requests ?? []).map((r) => {
                const completion = completionBadge(r);
                return (
                  <Card key={r.id} onPress={() => router.push({ pathname: "/van-stock/[id]", params: { id: r.id } })}>
                    <View style={s.rowTop}>
                      <Text style={s.code}>{r.code}</Text>
                      <Badge status={r.status} label={VSR_STATUS_LABELS[r.status]} />
                    </View>
                    <View style={s.badgeRow}>
                      <Badge status={r.type} label={titleCase(r.type)} />
                      {r.createdVia === "walk_in" ? <Badge status="draft" label="Walk-in" /> : null}
                      {completion ? <Badge status={completion.status} label={completion.label} /> : null}
                      {r.stale ? <Badge status="high" label="Stale" /> : null}
                      {r.priority !== "normal" ? <Badge status={r.priority} /> : null}
                    </View>
                    <Text style={s.meta} numberOfLines={1}>
                      {r.lines.length} item{r.lines.length === 1 ? "" : "s"} · {itemsSummary(r)}
                    </Text>
                    <Text style={s.meta}>{formatDateTime(r.createdAt)}</Text>
                    {r.status === "pending" ? (
                      <Button title="Cancel" variant="secondary" small onPress={() => confirmVanAction(r)} />
                    ) : null}
                    {hasRemainder(r) ? (
                      <Button title="Cancel remaining" variant="secondary" small onPress={() => confirmVanAction(r)} />
                    ) : null}
                  </Card>
                );
              })
            )}
            {vanRequests ? (
              <Pager
                page={vanRequests.page}
                totalPages={vanRequests.totalPages}
                onPage={setVanPage}
                total={vanRequests.total}
                label="requests"
              />
            ) : null}
          </ListFade>
          )}
        </>
      ) : null}

      {tab === "kit" && l3 ? <ListSkeleton /> : null}
      {tab === "kit" && !l3 ? (
        <>
          <Text style={s.hint}>Raise kit requests from a job&rsquo;s detail page.</Text>
          {kitError ? (
            <ErrorText message={kitError} />
          ) : (
          <ListFade dimmed={f3}>
            {(kitRequests?.requests ?? []).length === 0 ? (
              <EmptyState title="No kit requests" />
            ) : (
              (kitRequests?.requests ?? []).map((kr) => (
                <Card key={kr.id} onPress={() => router.push({ pathname: "/jobs/[id]", params: { id: kr.jobId } })}>
                  <View style={s.rowTop}>
                    <Text style={s.code}>{kr.code}</Text>
                    <Badge status={kr.status} />
                  </View>
                  <Text style={s.title}>{kr.jobNumber}</Text>
                  {/* Web's collapsed summary: granted qty per line; an excluded
                      line is struck through showing the asked qty. */}
                  <Text style={s.meta} numberOfLines={2}>
                    {kr.lines.slice(0, 3).map((l, i) => {
                      const o = kitLineOutcome(l);
                      return (
                        <Text key={l.id}>
                          {i > 0 ? " • " : ""}
                          <Text style={o.excluded ? s.struck : undefined}>
                            {l.itemName} ×{o.excluded ? l.qty : o.qty}
                          </Text>
                        </Text>
                      );
                    })}
                    {kr.lines.length > 3 ? ` • +${kr.lines.length - 3} more` : ""}
                  </Text>
                  {kr.status === "declined" && kr.decisionNote ? (
                    <Text style={s.meta}>Planner: {kr.decisionNote}</Text>
                  ) : null}
                </Card>
              ))
            )}
            {kitRequests ? (
              <Pager
                page={kitRequests.page}
                totalPages={kitRequests.totalPages}
                onPage={setKitPage}
                total={kitRequests.total}
                label="requests"
              />
            ) : null}
          </ListFade>
          )}
        </>
      ) : null}
    </Screen>
  );
}

const s = StyleSheet.create({
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  code: { fontSize: 13, fontWeight: "700", color: colors.accent },
  age: { fontSize: 12, fontWeight: "400", color: colors.muted },
  title: { fontSize: 14, fontWeight: "700", color: colors.text },
  phone: { color: colors.accent, fontWeight: "600" },
  meta: { fontSize: 12, color: colors.muted },
  struck: { textDecorationLine: "line-through", color: colors.faint },
  hint: { fontSize: 13, color: colors.muted },
  buttonRow: { flexDirection: "row", gap: 10 },
  flex1: { flex: 1 },
  badgeRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  signBanner: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  signTitle: { fontSize: 14, fontWeight: "700", color: colors.accent },
  signPill: { backgroundColor: colors.accent, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  signPillText: { fontSize: 11, fontWeight: "700", color: "#ffffff" },
});
