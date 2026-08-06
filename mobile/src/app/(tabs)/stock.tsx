import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import type { DateTimePickerEvent } from "@react-native-community/datetimepicker";
import {
  getOwnCustomerStock,
  getOwnMiscStock,
  getOwnMovements,
  getOwnStock,
} from "@/services/engineer.service";
import { useLoad } from "@/lib/useLoad";
import { useSocketRefresh } from "@/lib/useSocketRefresh";
import { useClientTable, type ClientTableOptions } from "@/lib/useClientTable";
import {
  Button,
  Card,
  Chips,
  EmptyState,
  ErrorText,
  FilterRow,
  Input,
  ListFade,
  ListSkeleton,
  Pager,
  Screen,
  Select,
} from "@/components/ui";
import { colors } from "@/lib/theme";
import { formatDate, formatDateTime, signed } from "@/lib/format";
import type { CustomerHolding, EngineerStockItem, MiscHeldItem, Movement } from "@/types";

// Section pills, captions, per-tab search/sort/pagination and movement filters
// mirror the web dashboard's EngineerInventory / MovementFeed.

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

// ── Client-side table configs (search / sort / 15-per-page, like the web) ────

const dateVal = (iso: string | null): number => {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

const IRM_TABLE: ClientTableOptions<EngineerStockItem> = {
  searchText: (s) => `${s.itemName} ${s.itemCode}`,
  comparators: {
    item: (a, b) => a.itemName.localeCompare(b.itemName),
    qty: (a, b) => a.quantityOnHand - b.quantityOnHand,
    updated: (a, b) => dateVal(a.lastMovedAt) - dateVal(b.lastMovedAt),
  },
  initialSort: "updated:desc",
};

const IRM_SORTS = [
  { key: "updated:desc", label: "Last updated (newest)" },
  { key: "updated:asc", label: "Last updated (oldest)" },
  { key: "item:asc", label: "Item (A–Z)" },
  { key: "item:desc", label: "Item (Z–A)" },
  { key: "qty:desc", label: "On hand (high–low)" },
  { key: "qty:asc", label: "On hand (low–high)" },
];

const CUSTOMER_TABLE: ClientTableOptions<CustomerHolding> = {
  searchText: (h) => `${h.itemName} ${h.customerName ?? ""}`,
  comparators: {
    item: (a, b) => a.itemName.localeCompare(b.itemName),
    customer: (a, b) => (a.customerName ?? "").localeCompare(b.customerName ?? ""),
    qty: (a, b) => a.quantityOnHand - b.quantityOnHand,
  },
  initialSort: "item:asc",
};

const CUSTOMER_SORTS = [
  { key: "item:asc", label: "Item (A–Z)" },
  { key: "item:desc", label: "Item (Z–A)" },
  { key: "customer:asc", label: "Customer (A–Z)" },
  { key: "customer:desc", label: "Customer (Z–A)" },
  { key: "qty:desc", label: "On hand (high–low)" },
  { key: "qty:asc", label: "On hand (low–high)" },
];

const MISC_TABLE: ClientTableOptions<MiscHeldItem> = {
  searchText: (m) => m.itemName,
  comparators: {
    item: (a, b) => a.itemName.localeCompare(b.itemName),
    qty: (a, b) => a.quantityOnHand - b.quantityOnHand,
  },
  initialSort: "item:asc",
};

const MISC_SORTS = [
  { key: "item:asc", label: "Item (A–Z)" },
  { key: "item:desc", label: "Item (Z–A)" },
  { key: "qty:desc", label: "On hand (high–low)" },
  { key: "qty:asc", label: "On hand (low–high)" },
];

function NoMatches() {
  return (
    <EmptyState title="No items match your search" subtitle="Try a different search or clear the filter." />
  );
}

// ── Movements feed (unchanged web-side) ──────────────────────────────────────

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
  const params = useLocalSearchParams<{ section?: string; t?: string }>();
  const [tab, setTab] = useState("irm");

  // Dashboard deep-links: /(tabs)/stock?section=irm|customer|movements seeds the
  // tab; the `t` nonce makes repeat taps of the same card re-seed.
  useEffect(() => {
    const section = params.section;
    if (typeof section !== "string" || !section) return;
    if (!SECTIONS.some((s) => s.key === section)) return;
    const timer = setTimeout(() => setTab(section), 0);
    return () => clearTimeout(timer);
  }, [params.section, params.t]);

  // ── Stock tabs ──────────────────────────────────────────────────────────────
  // One load per tab so each keeps its own loading/error state, like the web's
  // per-section fetches.
  const irmLoad = useLoad(getOwnStock);
  const customerLoad = useLoad(getOwnCustomerStock);
  const miscLoad = useLoad(getOwnMiscStock);
  const irm = irmLoad.data;
  const customer = customerLoad.data;
  const misc = miscLoad.data;

  // Like the web: a goods event refetches only the tab being looked at.
  useSocketRefresh(GOODS_EVENTS, () => {
    if (tab === "irm") void irmLoad.reload();
    else if (tab === "customer") void customerLoad.reload();
    else if (tab === "misc") void miscLoad.reload();
  });

  // Client-side search / sort / pagination per tab (15/page, like the web).
  const irmTable = useClientTable(irm ?? [], IRM_TABLE);

  const [customerFilter, setCustomerFilter] = useState("");
  const customerOptions = useMemo(() => {
    const names = [...new Set((customer ?? []).map((h) => h.customerName).filter((n): n is string => Boolean(n)))].sort(
      (a, b) => a.localeCompare(b),
    );
    return [{ key: "", label: "All customers" }, ...names.map((n) => ({ key: n, label: n }))];
  }, [customer]);
  // A refetch can drop the selected customer — fall back to "All" for this render
  // so the filter can never strand the view on an un-clearable empty list.
  const activeCustomer = customerOptions.some((o) => o.key === customerFilter) ? customerFilter : "";
  const customerPredicate = useMemo(
    () => (activeCustomer ? (h: CustomerHolding) => (h.customerName ?? "") === activeCustomer : undefined),
    [activeCustomer],
  );
  const customerTable = useClientTable(customer ?? [], CUSTOMER_TABLE, customerPredicate);

  const miscTable = useClientTable(misc ?? [], MISC_TABLE);

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

  const movementsLoad = useLoad(
    useCallback(async () => {
      const req = ++movReq.current;
      try {
        const page = await getOwnMovements({ limit: PAGE, ...filterParams() });
        if (req === movReq.current) {
          setMovements(page.movements);
          setCursor(page.nextCursor);
          setHasMore(page.hasMore);
        }
        return page;
      } catch (err) {
        // Like the web: a failed page-1 fetch resets the feed so rows from the
        // previous filters can't sit under the new ones, and the error message
        // takes the empty-state slot.
        if (req === movReq.current) {
          setMovements([]);
          setCursor(null);
          setHasMore(false);
        }
        throw err instanceof Error ? err : new Error("Could not load movements.");
      }
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

  // Pull-to-refresh targets whichever tab is on screen.
  const activeLoad =
    tab === "customer" ? customerLoad : tab === "misc" ? miscLoad : tab === "movements" ? movementsLoad : irmLoad;

  return (
    <Screen refreshing={activeLoad.refreshing} onRefresh={() => void activeLoad.refresh()}>
      <Chips options={SECTIONS} value={tab} onChange={setTab} />
      <Text style={s.caption}>{SECTION_CAPTIONS[tab]}</Text>

      {/* Each tab mirrors the web's branch order: loading → skeleton; error with
          no rows → banner only; source empty → empty state; else search + rows
          (an error with cached rows keeps the stale list under the banner). */}
      {tab === "irm" ? (
        irmLoad.loading ? (
          <ListSkeleton />
        ) : (
          <>
            <ErrorText message={irmLoad.error} />
            {(irm ?? []).length === 0 ? (
              irmLoad.error ? null : (
                <EmptyState
                  title="No IRM stock on hand"
                  subtitle="Stock dispatched to you from a warehouse will appear here."
                />
              )
            ) : (
              <>
                <Input
                  placeholder="Search item or code…"
                  value={irmTable.query}
                  onChangeText={irmTable.setQuery}
                  autoCapitalize="none"
                  returnKeyType="search"
                />
                <FilterRow>
                  <Select options={IRM_SORTS} value={irmTable.sort} onChange={irmTable.setSort} />
                </FilterRow>
                {irmTable.noMatches ? (
                  <NoMatches />
                ) : (
                  irmTable.rows.map((item) => (
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
                      <Text style={s.meta}>Last updated {formatDate(item.lastMovedAt)}</Text>
                    </Card>
                  ))
                )}
                {irmTable.total > 0 ? (
                  <Pager
                    page={irmTable.page}
                    totalPages={irmTable.totalPages}
                    onPage={irmTable.setPage}
                    total={irmTable.total}
                    label="items"
                  />
                ) : null}
              </>
            )}
          </>
        )
      ) : null}

      {tab === "customer" ? (
        customerLoad.loading ? (
          <ListSkeleton />
        ) : (
          <>
            <ErrorText message={customerLoad.error} />
            {(customer ?? []).length === 0 ? (
              customerLoad.error ? null : (
                <EmptyState
                  title="No customer stock held"
                  subtitle="Customer consignment items issued to you for a job will appear here."
                />
              )
            ) : (
              <>
                <Input
                  placeholder="Search item or customer…"
                  value={customerTable.query}
                  onChangeText={customerTable.setQuery}
                  autoCapitalize="none"
                  returnKeyType="search"
                />
                <FilterRow>
                  {customerOptions.length > 2 || activeCustomer !== "" ? (
                    <Select
                      options={customerOptions}
                      value={activeCustomer}
                      onChange={(key) => {
                        setCustomerFilter(key);
                        customerTable.setPage(1);
                      }}
                    />
                  ) : null}
                  <Select options={CUSTOMER_SORTS} value={customerTable.sort} onChange={customerTable.setSort} />
                </FilterRow>
                {customerTable.noMatches ? (
                  <NoMatches />
                ) : (
                  customerTable.rows.map((item) => (
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
                )}
                {customerTable.total > 0 ? (
                  <Pager
                    page={customerTable.page}
                    totalPages={customerTable.totalPages}
                    onPage={customerTable.setPage}
                    total={customerTable.total}
                    label="items"
                  />
                ) : null}
              </>
            )}
          </>
        )
      ) : null}

      {tab === "misc" ? (
        miscLoad.loading ? (
          <ListSkeleton />
        ) : (
          <>
            <ErrorText message={miscLoad.error} />
            {(misc ?? []).length === 0 ? (
              miscLoad.error ? null : (
                <EmptyState title="No misc items" subtitle="Misc kit items issued to you for a job will appear here." />
              )
            ) : (
              <>
                <Input
                  placeholder="Search item…"
                  value={miscTable.query}
                  onChangeText={miscTable.setQuery}
                  autoCapitalize="none"
                  returnKeyType="search"
                />
                <FilterRow>
                  <Select options={MISC_SORTS} value={miscTable.sort} onChange={miscTable.setSort} />
                </FilterRow>
                {miscTable.noMatches ? (
                  <NoMatches />
                ) : (
                  miscTable.rows.map((item, i) => (
                    <Card key={`${item.itemName}-${i}`}>
                      <View style={s.rowTop}>
                        <Text style={s.itemName} numberOfLines={2}>
                          {item.itemName}
                        </Text>
                        <Text style={s.qtyBig}>{item.quantityOnHand}</Text>
                      </View>
                    </Card>
                  ))
                )}
                {miscTable.total > 0 ? (
                  <Pager
                    page={miscTable.page}
                    totalPages={miscTable.totalPages}
                    onPage={miscTable.setPage}
                    total={miscTable.total}
                    label="items"
                  />
                ) : null}
              </>
            )}
          </>
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

          {movementsLoad.loading ? (
            <ListSkeleton />
          ) : (
            <ListFade dimmed={movementsLoad.fetching}>
              {movements.length === 0 ? (
                <EmptyState title={movementsLoad.error ?? "No movements match these filters"} />
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
          )}
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
