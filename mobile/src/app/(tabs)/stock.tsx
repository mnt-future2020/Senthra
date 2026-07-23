import React, { useCallback, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import type { DateTimePickerEvent } from "@react-native-community/datetimepicker";
import {
  getOwnCustomerStock,
  getOwnMiscStock,
  getOwnMovements,
  getOwnOverview,
  getOwnStock,
} from "@/services/engineer.service";
import { useLoad } from "@/lib/useLoad";
import { useSocketRefresh } from "@/lib/useSocketRefresh";
import {
  Button,
  Card,
  Chips,
  EmptyState,
  ErrorText,
  FilterRow,
  ListFade,
  ListSkeleton,
  Screen,
  Select,
} from "@/components/ui";
import { colors } from "@/lib/theme";
import { formatDate, formatDateTime, signed } from "@/lib/format";
import type { Movement } from "@/types";

// Section pills, captions and movement filters mirror the web dashboard's
// EngineerInventory / MovementFeed.

const SECTIONS = [
  { key: "irm", label: "Company (IRM)" },
  { key: "customer", label: "Customer" },
  { key: "misc", label: "Misc" },
  { key: "movements", label: "Movements" },
];

const SECTION_CAPTIONS: Record<string, string> = {
  irm: "Company (IRM) stock currently assigned to you.",
  customer: "Consignment items issued from a job — return these when the job is complete.",
  misc: "Free-text items handed to you on a job (no barcode / not stock-tracked).",
  movements:
    "Every movement of stock in and out of your van — dispatches, transfers, job issues, returns and consumption. Newest first.",
};

const OWNERSHIP_OPTIONS = [
  { key: "", label: "All ownership" },
  { key: "company", label: "Company" },
  { key: "customer", label: "Customer" },
];

const TYPE_OPTIONS = [
  { key: "", label: "All types" },
  { key: "goods_in", label: "Goods In" },
  { key: "goods_out", label: "Goods Out" },
  { key: "transfer_in", label: "Transfer In" },
  { key: "transfer_out", label: "Transfer Out" },
  { key: "manual_add", label: "Adjustment (add)" },
  { key: "manual_adjust", label: "Adjustment (remove)" },
  { key: "job_issue", label: "Job Issue" },
  { key: "job_return", label: "Job Return" },
  { key: "van_restock", label: "Field Restock" },
  { key: "van_return", label: "Field Return" },
  { key: "job_consume", label: "Consumed on Job" },
  { key: "job_lost", label: "Lost on Job" },
  { key: "write_off", label: "Marked Damaged" },
  { key: "restore", label: "Restored from Damaged" },
];

// The events the web inventory live-refreshes on (useGoodsSocket). The movements
// feed intentionally does not live-refresh, matching the web.
const GOODS_EVENTS = ["goods:issued", "goods:returned", "goods:updated", "engineer:transfer_updated"];

const PAGE = 25;

const toYMD = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function OwnerTag({ ownership }: { ownership: "company" | "customer" }) {
  const customer = ownership === "customer";
  return (
    <View style={[s.ownerTag, { backgroundColor: customer ? colors.accentSoft : colors.mutedSoft }]}>
      <Text style={[s.ownerTagText, { color: customer ? colors.accent : colors.muted }]}>
        {customer ? "Customer" : "IRM"}
      </Text>
    </View>
  );
}

function MovementCard({ m }: { m: Movement }) {
  return (
    <Card>
      <View style={s.rowTop}>
        <Text style={s.itemName} numberOfLines={1}>
          {m.itemName}
        </Text>
        <Text style={[s.qty, { color: m.quantityDelta >= 0 ? colors.success : colors.danger }]}>
          {signed(m.quantityDelta)}
        </Text>
      </View>
      {m.itemCode || m.sku ? <Text style={s.code}>{m.itemCode || m.sku}</Text> : null}
      <View style={s.tagRow}>
        <OwnerTag ownership={m.ownership} />
        <View style={s.typePill}>
          <Text style={s.typePillText}>{m.label}</Text>
        </View>
      </View>
      <Text style={s.meta}>
        {m.locationLabel || "—"} · Balance {m.balanceAfter ?? "—"}
      </Text>
      <Text style={s.meta}>
        Ref {m.reference ?? "—"} · By {m.actor ?? "—"}
      </Text>
      {m.fromLabel || m.toLabel ? (
        <Text style={s.meta}>
          {m.fromLabel ? `From ${m.fromLabel}` : ""}
          {m.fromLabel && m.toLabel ? " → " : ""}
          {m.toLabel ? `To ${m.toLabel}` : ""}
        </Text>
      ) : null}
      <Text style={s.meta}>{formatDateTime(m.date)}</Text>
    </Card>
  );
}

export default function StockScreen() {
  const [tab, setTab] = useState("irm");

  // ── Stock tabs ──────────────────────────────────────────────────────────────
  const { data: irm, loading: l1, refreshing, error, refresh, reload: reloadIrm } = useLoad(getOwnStock);
  const { data: customer, reload: reloadCustomer } = useLoad(getOwnCustomerStock);
  const { data: misc, reload: reloadMisc } = useLoad(getOwnMiscStock);
  const { data: overview, reload: reloadOverview } = useLoad(getOwnOverview);

  useSocketRefresh(GOODS_EVENTS, () => {
    void reloadIrm();
    void reloadCustomer();
    void reloadMisc();
    void reloadOverview();
  });

  // Web's IRM "Last updated" column: first recent-activity entry per item code.
  const lastUpdated = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of overview?.recentActivity ?? []) {
      if (!map[a.itemCode]) map[a.itemCode] = a.createdAt;
    }
    return map;
  }, [overview]);

  // ── Movements feed ──────────────────────────────────────────────────────────
  const [ownership, setOwnership] = useState("");
  const [mtype, setMtype] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [iosPicker, setIosPicker] = useState<"from" | "to" | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const movReq = useRef(0);

  const filterParams = useCallback(
    () => ({
      ownership: ownership || undefined,
      type: mtype || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    }),
    [ownership, mtype, dateFrom, dateTo],
  );

  const { loading: l2, fetching: fMov } = useLoad(
    useCallback(async () => {
      const req = ++movReq.current;
      const page = await getOwnMovements({ limit: PAGE, ...filterParams() });
      if (req === movReq.current) {
        setMovements(page.movements);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      }
      return page;
    }, [filterParams]),
  );

  const loadMore = async () => {
    if (!cursor) return;
    const req = movReq.current;
    setLoadingMore(true);
    try {
      const page = await getOwnMovements({ limit: PAGE, cursor, ...filterParams() });
      if (req === movReq.current) {
        setMovements((prev) => [...prev, ...page.movements]);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      }
    } catch {
      // Load-more failures keep existing rows, like the web feed.
    } finally {
      setLoadingMore(false);
    }
  };

  const hasActiveFilter = Boolean(ownership || mtype || dateFrom || dateTo);
  const clearFilters = () => {
    setOwnership("");
    setMtype("");
    setDateFrom("");
    setDateTo("");
  };

  const setDateFilter = (which: "from" | "to", ymd: string) => {
    if (which === "from") setDateFrom(ymd);
    else setDateTo(ymd);
  };

  const openDatePicker = (which: "from" | "to") => {
    const current = which === "from" ? dateFrom : dateTo;
    const value = current ? new Date(current) : new Date();
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value,
        mode: "date",
        onChange: (event: DateTimePickerEvent, d?: Date) => {
          if (event.type === "set" && d) setDateFilter(which, toYMD(d));
        },
      });
    } else {
      setIosPicker(which);
    }
  };

  if (l1 || l2)
    return (
      <Screen>
        <ListSkeleton />
      </Screen>
    );

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <Chips options={SECTIONS} value={tab} onChange={setTab} />
      <Text style={s.caption}>{SECTION_CAPTIONS[tab]}</Text>
      <ErrorText message={error} />

      {tab === "irm" ? (
        (irm ?? []).length === 0 ? (
          <EmptyState title="No IRM stock on hand" subtitle="Stock dispatched to you from a warehouse will appear here." />
        ) : (
          (irm ?? []).map((item) => (
            <Card key={item.irmItemId}>
              <View style={s.rowTop}>
                <Text style={s.itemName} numberOfLines={2}>
                  {item.itemName}
                </Text>
                <Text style={s.qtyBig}>
                  {item.quantityOnHand}
                  {item.baseUnit ? ` ${item.baseUnit}` : ""}
                </Text>
              </View>
              <Text style={s.code}>{item.itemCode}</Text>
              <Text style={s.meta}>Last updated {formatDate(lastUpdated[item.itemCode] ?? null)}</Text>
            </Card>
          ))
        )
      ) : null}

      {tab === "customer" ? (
        (customer ?? []).length === 0 ? (
          <EmptyState
            title="No customer stock held"
            subtitle="Customer consignment items issued to you for a job will appear here."
          />
        ) : (
          (customer ?? []).map((item) => (
            <Card key={item.id}>
              <View style={s.rowTop}>
                <Text style={s.itemName} numberOfLines={2}>
                  {item.itemName}
                </Text>
                <Text style={s.qtyBig}>{item.quantityOnHand}</Text>
              </View>
              <Text style={s.meta}>{item.customerName ?? "—"}</Text>
            </Card>
          ))
        )
      ) : null}

      {tab === "misc" ? (
        (misc ?? []).length === 0 ? (
          <EmptyState title="No misc items" subtitle="Misc kit items issued to you for a job will appear here." />
        ) : (
          (misc ?? []).map((item, i) => (
            <Card key={`${item.itemName}-${i}`}>
              <View style={s.rowTop}>
                <Text style={s.itemName} numberOfLines={2}>
                  {item.itemName}
                </Text>
                <Text style={s.qtyBig}>{item.quantityOnHand}</Text>
              </View>
            </Card>
          ))
        )
      ) : null}

      {tab === "movements" ? (
        <>
          <FilterRow>
            <Select options={OWNERSHIP_OPTIONS} value={ownership} onChange={setOwnership} />
            <Select options={TYPE_OPTIONS} value={mtype} onChange={setMtype} />
          </FilterRow>
          <View style={s.dateRow}>
            <Pressable style={s.dateChip} onPress={() => openDatePicker("from")}>
              <Text style={s.dateChipText}>From: {dateFrom ? formatDate(dateFrom) : "—"}</Text>
            </Pressable>
            <Pressable style={s.dateChip} onPress={() => openDatePicker("to")}>
              <Text style={s.dateChipText}>To: {dateTo ? formatDate(dateTo) : "—"}</Text>
            </Pressable>
            {hasActiveFilter ? (
              <Button title="Clear filters" variant="ghost" small onPress={clearFilters} />
            ) : null}
          </View>
          {Platform.OS === "ios" && iosPicker ? (
            <Card>
              <DateTimePicker
                value={
                  (iosPicker === "from" ? dateFrom : dateTo)
                    ? new Date(iosPicker === "from" ? dateFrom : dateTo)
                    : new Date()
                }
                mode="date"
                display="spinner"
                onChange={(event: DateTimePickerEvent, d?: Date) => {
                  if (d) setDateFilter(iosPicker, toYMD(d));
                }}
              />
              <Button title="Done" variant="secondary" small onPress={() => setIosPicker(null)} />
            </Card>
          ) : null}

          <ListFade dimmed={fMov}>
            {movements.length === 0 ? (
              <EmptyState title="No movements match these filters" />
            ) : (
              <>
                {movements.map((m) => (
                  <MovementCard key={m.id} m={m} />
                ))}
                {hasMore ? (
                  <Button title="Load more" variant="secondary" loading={loadingMore} onPress={() => void loadMore()} />
                ) : null}
              </>
            )}
          </ListFade>
        </>
      ) : null}
    </Screen>
  );
}

const s = StyleSheet.create({
  caption: { fontSize: 13, color: colors.muted },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 10 },
  itemName: { fontSize: 14, fontWeight: "700", color: colors.text, flex: 1 },
  qtyBig: { fontSize: 18, fontWeight: "800", color: colors.text },
  qty: { fontSize: 16, fontWeight: "800" },
  code: { fontSize: 12, color: colors.faint },
  meta: { fontSize: 12, color: colors.muted },
  tagRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  ownerTag: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  ownerTagText: { fontSize: 11, fontWeight: "700" },
  typePill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  typePillText: { fontSize: 11, fontWeight: "600", color: colors.muted },
  dateRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  dateChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  dateChipText: { fontSize: 13, fontWeight: "600", color: colors.text },
});
