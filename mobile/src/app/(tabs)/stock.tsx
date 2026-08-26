import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useLocalSearchParams } from "expo-router";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import type { DateTimePickerEvent } from "@react-native-community/datetimepicker";
import {
  getOwnCustomerStock,
  getOwnMiscStock,
  getOwnMovements,
  getOwnRentals,
  getOwnStock,
  type RentalHolding,
} from "@/services/engineer.service";
import { dueLabel } from "@/lib/hireDeadline";
import { useLoad } from "@/lib/useLoad";
import { useSocketRefresh } from "@/lib/useSocketRefresh";
import { useClientTable, type ClientTableOptions } from "@/lib/useClientTable";
import {
  Button,
  Card,
  Chips,
  EmptyState,
  ErrorText,
  FilterButton,
  FilterGroup,
  ListFade,
  ListSkeleton,
  Pager,
  Screen,
  SearchFilterBar,
} from "@/components/ui";
import { colors } from "@/lib/theme";
import { formatDate, formatDateTime, signed } from "@/lib/format";
import type { CustomerHolding, EngineerStockItem, MiscHeldItem, Movement } from "@/types";

// Section pills, captions, per-tab search/sort/pagination and movement filters
// mirror the web dashboard's EngineerInventory / MovementFeed.

// Section pills carry the same glyphs as the web's EngineerInventory tabs, mapped to the icon sets
// this app already ships: Boxes→cube, Package→people, CalendarClock→calendar-clock, Wrench→wrench,
// History→history. `icon` is a function of the colour because a chip inverts when it goes active.
const SECTIONS = [
  { key: "irm", label: "Company (IRM)", icon: (c: string) => <Ionicons name="cube" size={14} color={c} /> },
  { key: "customer", label: "Customer", icon: (c: string) => <Ionicons name="people" size={14} color={c} /> },
  {
    key: "rental",
    label: "Hired",
    icon: (c: string) => <MaterialCommunityIcons name="calendar-clock" size={14} color={c} />,
  },
  {
    key: "misc",
    label: "Misc",
    icon: (c: string) => <MaterialCommunityIcons name="wrench-outline" size={14} color={c} />,
  },
  {
    key: "movements",
    label: "Movements",
    icon: (c: string) => <MaterialCommunityIcons name="history" size={14} color={c} />,
  },
];

const SECTION_CAPTIONS: Record<string, string> = {
  irm: "Company (IRM) stock currently assigned to you.",
  customer: "Consignment items issued from a job — return these when the job is complete.",
  rental: "Hired equipment you're carrying. It belongs to a provider and bills by the day — soonest return first.",
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

// A large FINITE sentinel for an undated hire, not Infinity: two undated rows would otherwise give
// Infinity − Infinity = NaN, and a comparator returning NaN makes the sort order undefined.
const UNDATED = 8.64e15;

const RENTAL_TABLE: ClientTableOptions<RentalHolding> = {
  searchText: (r) => r.itemName,
  comparators: {
    item: (a, b) => a.itemName.localeCompare(b.itemName),
    qty: (a, b) => a.quantityOnHand - b.quantityOnHand,
    // Undated hires sort last in the DEFAULT (ascending) order, which is the one that matters: an
    // unknown deadline is not an urgent one, and letting it lead would push a genuinely overdue hire
    // off the top.
    due: (a, b) => (a.hireEndDate ? dateVal(a.hireEndDate) : UNDATED) - (b.hireEndDate ? dateVal(b.hireEndDate) : UNDATED),
  },
  initialSort: "due:asc",
};

const RENTAL_SORTS = [
  { key: "due:asc", label: "Return by (soonest)" },
  { key: "due:desc", label: "Return by (latest)" },
  { key: "item:asc", label: "Item (A–Z)" },
  { key: "item:desc", label: "Item (Z–A)" },
  { key: "qty:desc", label: "On hire (high–low)" },
  { key: "qty:asc", label: "On hire (low–high)" },
];

function NoMatches() {
  return (
    <EmptyState
      icon={<Ionicons name="search" size={20} color={colors.faint} />}
      title="No items match your search"
      subtitle="Try a different search or clear the filter."
    />
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
  const rentalLoad = useLoad(getOwnRentals);
  const miscLoad = useLoad(getOwnMiscStock);
  const irm = irmLoad.data;
  const customer = customerLoad.data;
  const rentals = rentalLoad.data;
  const misc = miscLoad.data;

  // Like the web: a goods event refetches only the tab being looked at.
  useSocketRefresh(GOODS_EVENTS, () => {
    if (tab === "irm") void irmLoad.reload();
    else if (tab === "customer") void customerLoad.reload();
    else if (tab === "rental") void rentalLoad.reload();
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

  const rentalTable = useClientTable(rentals ?? [], RENTAL_TABLE);
  // Counted off the FULL holding list, not the paged/filtered rows: an overdue hire the engineer has
  // searched past is still overdue, and the banner exists to say so.
  const overdueHires = (rentals ?? []).filter((r) => r.overdue).length;

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
    tab === "customer"
      ? customerLoad
      : tab === "rental"
        ? rentalLoad
        : tab === "misc"
          ? miscLoad
          : tab === "movements"
            ? movementsLoad
            : irmLoad;

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
                  icon={<Ionicons name="cube" size={20} color={colors.faint} />}
                  title="No IRM stock on hand"
                  subtitle="Stock dispatched to you from a warehouse will appear here."
                />
              )
            ) : (
              <>
                <SearchFilterBar
                  placeholder="Search item or code…"
                  value={irmTable.query}
                  onChangeText={irmTable.setQuery}
                  activeCount={irmTable.sort === IRM_TABLE.initialSort ? 0 : 1}
                  onClear={() => irmTable.setSort(IRM_TABLE.initialSort!)}
                >
                  <FilterGroup
                    label="Sort"
                    options={IRM_SORTS}
                    value={irmTable.sort}
                    onChange={irmTable.setSort}
                  />
                </SearchFilterBar>
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
                  icon={<Ionicons name="people" size={20} color={colors.faint} />}
                  title="No customer stock held"
                  subtitle="Customer consignment items issued to you for a job will appear here."
                />
              )
            ) : (
              <>
                <SearchFilterBar
                  placeholder="Search item or customer…"
                  value={customerTable.query}
                  onChangeText={customerTable.setQuery}
                  activeCount={
                    (activeCustomer ? 1 : 0) + (customerTable.sort === CUSTOMER_TABLE.initialSort ? 0 : 1)
                  }
                  onClear={() => {
                    setCustomerFilter("");
                    customerTable.setSort(CUSTOMER_TABLE.initialSort!);
                    customerTable.setPage(1);
                  }}
                >
                  {/* Only worth showing when there is actually a choice to make — one customer, or
                      none, and the control is a dropdown with a single answer. */}
                  {customerOptions.length > 2 || activeCustomer !== "" ? (
                    <FilterGroup
                      label="Customer"
                      options={customerOptions}
                      value={activeCustomer}
                      onChange={(key) => {
                        setCustomerFilter(key);
                        customerTable.setPage(1);
                      }}
                    />
                  ) : null}
                  <FilterGroup
                    label="Sort"
                    options={CUSTOMER_SORTS}
                    value={customerTable.sort}
                    onChange={customerTable.setSort}
                  />
                </SearchFilterBar>
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

      {tab === "rental" ? (
        rentalLoad.loading ? (
          <ListSkeleton />
        ) : (
          <>
            <ErrorText message={rentalLoad.error} />
            {overdueHires > 0 ? (
              // Amber, not red: by the web portal's own tone rule red means broken or blocked, and
              // nothing here is blocked — the engineer can still do everything. It is a real cost
              // leaking, so it earns a banner, but it is an advisory to act on.
              <View style={s.hireWarn}>
                <Text style={s.hireWarnText}>
                  {`${overdueHires} hired item${overdueHires === 1 ? " is" : "s are"} past the return date. `}
                  {`Hired kit keeps costing while it's out and has to go back to the provider — take ${overdueHires === 1 ? "it" : "them"} to the warehouse.`}
                </Text>
              </View>
            ) : null}
            {(rentals ?? []).length === 0 ? (
              rentalLoad.error ? null : (
                <EmptyState
                  icon={<MaterialCommunityIcons name="calendar-clock" size={20} color={colors.faint} />}
                  title="No hired kit with you"
                  subtitle="Rental equipment issued to you for a job will appear here, with its return date."
                />
              )
            ) : (
              <>
                <SearchFilterBar
                  placeholder="Search item…"
                  value={rentalTable.query}
                  onChangeText={rentalTable.setQuery}
                  activeCount={rentalTable.sort === RENTAL_TABLE.initialSort ? 0 : 1}
                  onClear={() => rentalTable.setSort(RENTAL_TABLE.initialSort!)}
                >
                  <FilterGroup
                    label="Sort"
                    options={RENTAL_SORTS}
                    value={rentalTable.sort}
                    onChange={rentalTable.setSort}
                  />
                </SearchFilterBar>
                {rentalTable.noMatches ? (
                  <NoMatches />
                ) : (
                  rentalTable.rows.map((item) => (
                    <Card key={item.id}>
                      <View style={s.rowTop}>
                        <Text style={s.itemName} numberOfLines={2}>
                          {item.itemName}
                        </Text>
                        <Text style={s.qtyBig}>{item.quantityOnHand}</Text>
                      </View>
                      <Text style={[s.meta, item.overdue && s.overdueText]}>
                        {item.hireEndDate ? `Return by ${formatDate(item.hireEndDate)}` : "Return by —"}
                      </Text>
                      <Text style={[s.hireDue, item.overdue && s.overdueText]}>{dueLabel(item)}</Text>
                    </Card>
                  ))
                )}
                {rentalTable.total > 0 ? (
                  <Pager
                    page={rentalTable.page}
                    totalPages={rentalTable.totalPages}
                    onPage={rentalTable.setPage}
                    total={rentalTable.total}
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
                <EmptyState
                  icon={<MaterialCommunityIcons name="wrench-outline" size={20} color={colors.faint} />}
                  title="No misc items"
                  subtitle="Misc kit items issued to you for a job will appear here."
                />
              )
            ) : (
              <>
                <SearchFilterBar
                  placeholder="Search item…"
                  value={miscTable.query}
                  onChangeText={miscTable.setQuery}
                  activeCount={miscTable.sort === MISC_TABLE.initialSort ? 0 : 1}
                  onClear={() => miscTable.setSort(MISC_TABLE.initialSort!)}
                >
                  <FilterGroup
                    label="Sort"
                    options={MISC_SORTS}
                    value={miscTable.sort}
                    onChange={miscTable.setSort}
                  />
                </SearchFilterBar>
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
          {/* No search box on the ledger, so the trigger sits with the dates instead.
              The DATE RANGE deliberately stays out here: it is the axis a ledger is actually read
              along, while ownership and type are set once and left — the same split the web's
              MovementFeed makes. Each chip shows its own value, so nothing is hidden by folding. */}
          <View style={s.dateRow}>
            <Pressable style={s.dateChip} onPress={() => openDatePicker("from")}>
              <Text style={s.dateChipText}>From: {dateFrom ? formatDate(dateFrom) : "—"}</Text>
            </Pressable>
            <Pressable style={s.dateChip} onPress={() => openDatePicker("to")}>
              <Text style={s.dateChipText}>To: {dateTo ? formatDate(dateTo) : "—"}</Text>
            </Pressable>
            <View style={s.flex1} />
            <FilterButton
              activeCount={(ownership ? 1 : 0) + (mtype ? 1 : 0)}
              onClear={clearFilters}
            >
              <FilterGroup label="Ownership" options={OWNERSHIP_OPTIONS} value={ownership} onChange={setOwnership} />
              <FilterGroup label="Movement type" options={TYPE_OPTIONS} value={mtype} onChange={setMtype} />
            </FilterButton>
          </View>
          {hasActiveFilter ? (
            <Button title="Clear filters" variant="ghost" small onPress={clearFilters} />
          ) : null}
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
                <EmptyState
                  // Shown for the error case too, exactly as the web's MovementFeed does: the glyph
                  // labels the surface ("this is the movement feed"), not the outcome.
                  icon={<MaterialCommunityIcons name="script-text-outline" size={20} color={colors.faint} />}
                  title={movementsLoad.error ?? "No movements match these filters"}
                />
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
  // Hire deadline: the sentence an engineer acts on, so it carries weight even before it turns red.
  hireDue: { fontSize: 12, fontWeight: "700", color: colors.text, marginTop: 2 },
  overdueText: { color: colors.danger },
  hireWarn: {
    backgroundColor: colors.warnSoft,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  hireWarnText: { fontSize: 12, fontWeight: "600", color: colors.warn, lineHeight: 17 },
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
  flex1: { flex: 1 },
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
