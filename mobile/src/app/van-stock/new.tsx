import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  createVanStockRequest,
  getVanStockAvailability,
  myOpenLineItems,
  searchRequestableItems,
  uploadVanStockAttachment,
} from "@/services/vanStock.service";
import type { RequestableItemOption, WarehouseAvailability } from "@/services/vanStock.service";
import { useLoad } from "@/lib/useLoad";
import { useDebouncedCallback } from "@/lib/useDebounced";
import { useToast } from "@/lib/toast";
import { openLineAdvisory } from "@/lib/openLineAdvisory";
import { splitItemKeys, toLinePayload, vanStockItemKey } from "@/lib/vanStockLine";
import { formatHireDate } from "@/lib/format";
import { AttachmentPicker } from "@/components/AttachmentPicker";
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  InfoRow,
  Input,
  RentalBadge,
  Screen,
  SearchInput,
  SectionTitle,
  Segmented,
  Select,
  Stepper,
} from "@/components/ui";
import { colors } from "@/lib/theme";
import type { VanStockLineSource, VanStockPriority } from "@/types";

// Field Stock runs a two-level scale: Normal or Urgent. The web composer, the counter walk-in and
// this screen must offer the same rungs — the backend enum rejects anything else outright.
const PRIORITY_OPTIONS: { key: VanStockPriority; label: string }[] = [
  { key: "normal", label: "Normal" },
  { key: "urgent", label: "Urgent" },
];

interface DraftLine {
  /** Composite `irm:<id>` / `rental:<id>` — see lib/vanStockLine.ts. The row's identity everywhere:
   *  React key, warehouse pick, availability lookup, dedupe. NEVER a bare item id. */
  key: string;
  source: VanStockLineSource;
  irmItemId: string | null;
  rentalItemId: string | null;
  itemName: string;
  code: string;
  qty: number;
  /** Rental only — carried onto the row so the deadline stays visible while the cart is built. */
  hireEndDate: string | null;
}

// Restock composer — request company stock OR hired kit from a warehouse onto your van (non-job).
// Mirrors the web VanStockComposer: live per-warehouse counts (a snapshot, not a reservation), a
// non-blocking duplicate warning for items already on an open request, and image attachments.
//
// TWO POOLS, one cart. `irm` is company stock. `rental` is HIRED equipment — the same pool a job kit
// request can draw on, reached from the non-job door. They travel together but are never merged: the
// id spaces are independent (hence the composite key on every row), a hire has no shelf balance (its
// figure is free-on-hire at a depot), and a hire can only be collected from — and returned to — the
// depot that took delivery, where company stock can come from any warehouse holding it.
export default function NewVanStockScreen() {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RequestableItemOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  // item KEY → the warehouse this line is collected from. Replaces the single request-level
  // "collect from": the engineer picks per item, seeing that warehouse's free count.
  const [lineWarehouses, setLineWarehouses] = useState<Record<string, string>>({});
  const [priority, setPriority] = useState<VanStockPriority>("normal");
  const [reason, setReason] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [availability, setAvailability] = useState<WarehouseAvailability[]>([]);
  const [availabilityError, setAvailabilityError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const searchSeq = useRef(0);
  const availSeq = useRef(0);

  // Advisory duplicate guard — items already on my OPEN restock requests.
  const {
    data: openLines,
    refreshing,
    refresh: refreshOpenLines,
  } = useLoad(useCallback(() => myOpenLineItems("restock"), []));
  // Bumped by pull-to-refresh so the live shelf counts refetch too.
  const [availTick, setAvailTick] = useState(0);

  const runSearch = useCallback(async (q: string) => {
    // One character, like the web's VanStockItemSearch. Item codes are short, and a two-character
    // floor silently refused the shortest of them.
    if (!q.trim()) {
      setResults([]);
      setSearchFailed(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    try {
      const found = await searchRequestableItems(q.trim());
      if (seq === searchSeq.current) {
        setResults(found);
        setSearchFailed(false);
      }
    } catch {
      if (seq === searchSeq.current) {
        setResults([]);
        setSearchFailed(true);
      }
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, []);

  const debouncedSearch = useDebouncedCallback(runSearch);

  // Live counts, refetched when the item SET changes (not quantities). Keyed the same way the cart
  // is, so a hire and a company item can never collapse onto one lookup.
  const itemIdsKey = useMemo(
    () =>
      lines
        .map((l) => l.key)
        .sort()
        .join(","),
    [lines],
  );
  useEffect(() => {
    // Empty cart renders no warehouse options, so stale availability is harmless.
    if (!itemIdsKey) return;
    const seq = ++availSeq.current;
    const { irmItemIds, rentalItemIds } = splitItemKeys(itemIdsKey.split(","));
    getVanStockAvailability(irmItemIds, rentalItemIds)
      .then((warehouses) => {
        if (seq === availSeq.current) {
          setAvailability(warehouses);
          setAvailabilityError(false);
        }
      })
      .catch(() => {
        if (seq === availSeq.current) setAvailabilityError(true);
      });
  }, [itemIdsKey, availTick]);

  const addItem = (item: RequestableItemOption) => {
    const key = vanStockItemKey(item);
    if (!lines.some((l) => l.key === key)) {
      // The item's own source travels with the row from here all the way to the payload, so what the
      // engineer tapped and what the warehouse is asked for cannot come apart in between.
      setLines((prev) => [
        ...prev,
        {
          key,
          source: item.source,
          irmItemId: item.irmItemId,
          rentalItemId: item.rentalItemId,
          itemName: item.name,
          code: item.code,
          qty: 1,
          hireEndDate: item.hireEndDate,
        },
      ]);
    }
    // The results STAY. A restock is usually several items off one search, and clearing the list
    // after each tap made the engineer retype the term per item. Added rows mark themselves below
    // instead — the same thing the web does with its `excludeIds` check.
  };

  // Rows already in the cart: marked and inert, rather than a tap that silently does nothing.
  const addedKeys = useMemo(() => new Set(lines.map((l) => l.key)), [lines]);

  // Matched on the COMPOSITE key, not a bare id — the open-lines feed carries hires as well now, and
  // the two catalogues have independent id spaces.
  const openKeys = useMemo(() => new Map((openLines ?? []).map((o) => [vanStockItemKey(o), o.code])), [openLines]);
  const advisory = openLineAdvisory(
    lines.filter((l) => openKeys.has(l.key)).map((l) => ({ name: l.itemName, code: openKeys.get(l.key) })),
    "restock",
  );

  // Per ITEM: the warehouses that actually hold it, most first, each labelled with its free count —
  // the engineer's whole basis for choosing. Warehouses with none of that item are left OUT rather
  // than shown disabled: the row is about this one item, so a warehouse with none of it is simply
  // not an answer.
  const warehouseOptionsByItem = useMemo(() => {
    const map = new Map<string, { key: string; label: string; free: number }[]>();
    for (const l of lines) {
      const opts = availability
        .map((w) => {
          // Two pools, read from the list that matches THIS line's catalogue. Hired kit has no stock
          // balance at all — its figure is free-on-hire at that depot — so reading `items` for a
          // rental line would silently report zero and hide every depot that actually holds it.
          const free =
            l.source === "rental"
              ? (w.rentalItems.find((i) => i.rentalItemId === l.rentalItemId)?.quantityOnHand ?? 0)
              : (w.items.find((i) => i.irmItemId === l.irmItemId)?.quantityOnHand ?? 0);
          const name = w.warehouseCode ? `${w.warehouseName} (${w.warehouseCode})` : w.warehouseName;
          return { key: w.warehouseId, label: `${name} — ${free} free`, free };
        })
        .filter((o) => o.free > 0)
        .sort((a, b) => b.free - a.free || a.label.localeCompare(b.label));
      map.set(l.key, opts);
    }
    return map;
  }, [availability, lines]);

  // What each line ACTUALLY collects from: the engineer's explicit pick when they made one and it is
  // still stocked there, otherwise the warehouse holding the most of that item. Derived during render
  // rather than written back by an effect, so `lineWarehouses` keeps meaning exactly one thing: what
  // the ENGINEER chose. A pick that stops being valid (stock ran out there between refreshes)
  // silently falls back instead of leaving the line pointing at an empty shelf.
  const effectiveWarehouses = useMemo(() => {
    const out: Record<string, string> = {};
    for (const l of lines) {
      const opts = warehouseOptionsByItem.get(l.key) ?? [];
      const picked = lineWarehouses[l.key];
      const valid = picked && opts.some((o) => o.key === picked);
      const chosen = valid ? picked : opts[0]?.key;
      if (chosen) out[l.key] = chosen;
    }
    return out;
  }, [lines, warehouseOptionsByItem, lineWarehouses]);

  // How many separate places this request sends the engineer to. Shown while it can still be changed.
  const stops = useMemo(() => new Set(Object.values(effectiveWarehouses)).size, [effectiveWarehouses]);
  const unplaced = lines.filter((l) => !effectiveWarehouses[l.key]);
  // The Stepper can only emit clamped integers, so no Number.isFinite guard is needed here as there
  // is on the web's free-text qty input.
  const totalQty = lines.reduce((n, l) => n + l.qty, 0);

  // Free count at the warehouse THIS line is collected from — the cap the qty stepper is judged
  // against. Same two-pool split as the options above.
  const shelfByItem = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lines) {
      const whId = effectiveWarehouses[l.key];
      if (!whId) continue;
      const w = availability.find((a) => a.warehouseId === whId);
      const free =
        l.source === "rental"
          ? w?.rentalItems.find((i) => i.rentalItemId === l.rentalItemId)?.quantityOnHand
          : w?.items.find((i) => i.irmItemId === l.irmItemId)?.quantityOnHand;
      if (typeof free === "number") m.set(l.key, free);
    }
    return m;
  }, [availability, lines, effectiveWarehouses]);

  // Switching a line to a warehouse with less stock leaves an already-set qty above the new cap
  // (clamping it silently would rewrite a number the engineer chose), so it's caught here instead.
  const overCap = lines.find((l) => {
    const free = shelfByItem.get(l.key);
    return typeof free === "number" && l.qty > free;
  });

  const submit = async () => {
    if (lines.length === 0) {
      setError("Add at least one item.");
      return;
    }
    if (overCap) {
      const free = shelfByItem.get(overCap.key) ?? 0;
      const where = overCap.source === "rental" ? "free on hire at the depot" : "free at the warehouse";
      setError(
        `Only ${free} of "${overCap.itemName}" are ${where} you picked — lower the quantity or collect it from somewhere else.`,
      );
      return;
    }
    if (unplaced.length > 0) {
      // Only reachable when an item is held NOWHERE (auto-select fills every other case). The two
      // pools fail for different reasons and have different remedies: company stock gets ORDERED,
      // a hire gets ARRANGED — telling an engineer to order a hire sends them to the wrong desk.
      const u = unplaced[0]!;
      setError(
        u.source === "rental"
          ? `No warehouse has "${u.itemName}" free on hire — remove it or ask the office to arrange a hire.`
          : `No warehouse has "${u.itemName}" in stock — remove it or ask the office to order it.`,
      );
      return;
    }
    if (!reason.trim()) {
      setError("Tell the warehouse why you need this.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createVanStockRequest({
        type: "restock",
        reason: reason.trim(),
        priority,
        // No request-level warehouse: the collection point is derived server-side from the lines.
        attachments: attachments.length ? attachments : undefined,
        // Built through toLinePayload so exactly one id travels with the discriminator — the server
        // refuses a line carrying both outright, and the wrong one would move company stock for a hire.
        lines: lines.map((l) =>
          toLinePayload({ ...l, name: l.itemName }, effectiveWarehouses[l.key]!),
        ),
      });
      toast.success("Restock request sent to the warehouse.");
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the request.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={() => {
        void refreshOpenLines();
        setAvailTick((t) => t + 1);
      }}
    >
      <Text style={s.hint}>
        The warehouse reviews, confirms the fulfilment warehouse and scans it out to you.
      </Text>

      <SectionTitle>Add items</SectionTitle>
      <Text style={s.hint}>Search the catalogue for the stock you need.</Text>
      <SearchInput
        placeholder="Search the item you need…"
        value={query}
        onChangeText={(v) => {
          setQuery(v);
          debouncedSearch(v);
        }}
      />
      {searching ? <Text style={s.hint}>Searching…</Text> : null}
      {searchFailed ? (
        <Text style={s.searchError}>Couldn&rsquo;t run the search just now. Check your connection and try again.</Text>
      ) : null}
      {query.trim().length > 0 && !searching && !searchFailed && results.length === 0 ? (
        <Text style={s.hint}>No matching item in the catalogue.</Text>
      ) : null}
      {results.map((item) => {
        // Held at NO warehouse — nobody can fulfil it, so show it (the engineer sees the item exists)
        // but don't let it be added. Mirrors the web composer.
        const isRental = item.source === "rental";
        const outOfStock = item.quantityOnHand <= 0;
        const added = addedKeys.has(vanStockItemKey(item));
        return (
          <Card
            key={vanStockItemKey(item)}
            onPress={outOfStock || added ? undefined : () => addItem(item)}
            style={outOfStock || added ? s.oosCard : undefined}
          >
            <View style={s.lineRow}>
              <View style={s.lineMain}>
                <View style={s.nameRow}>
                  <Text style={s.lineName}>{item.name}</Text>
                  {isRental ? <RentalBadge /> : null}
                </View>
                <Text style={s.meta}>
                  {item.code}
                  {item.sku ? ` · ${item.sku}` : ""}
                  {item.uom ? ` · ${item.uom}` : ""}
                  {isRental && item.poCodes.length > 0 ? ` · ${item.poCodes.join(", ")}` : ""}
                </Text>
                {/* UTC-pinned: a hire deadline is a calendar day, and formatDate would show the day
                    before on any device behind UTC. See lib/format.ts#formatHireDate. */}
                {isRental && item.hireEndDate ? (
                  <Text style={s.meta}>Hire ends {formatHireDate(item.hireEndDate)}</Text>
                ) : null}
              </View>
              <View style={s.resultRight}>
                <Text style={[s.meta, { fontWeight: "700", color: outOfStock ? colors.danger : colors.success }]}>
                  {/* "In stock" is untrue of a rental — it is not our stock, and the figure is bounded
                      by a hire period rather than by what we own. Same split the web draws. */}
                  {outOfStock
                    ? isRental
                      ? "None free on hire"
                      : "Out of stock"
                    : isRental
                      ? `${item.quantityOnHand} free on hire`
                      : `${item.quantityOnHand} in stock`}
                </Text>
                {added ? <Text style={s.addedText}>✓ Added</Text> : null}
              </View>
            </View>
          </Card>
        );
      })}

      <SectionTitle>{lines.length ? `Selected items (${lines.length})` : "Selected items"}</SectionTitle>
      <Text style={s.hint}>Set the quantity, and where you&rsquo;ll collect each item from.</Text>
      {advisory ? (
        // Fixed-length sentence up top, the names demoted to a second line — so a third clashing item
        // costs no height. See lib/openLineAdvisory.ts for why the old one-string version was wrong.
        <Card style={s.warnCard}>
          <Text style={s.warnText}>{advisory.text}</Text>
          {advisory.detail ? <Text style={s.warnDetail}>{advisory.detail}</Text> : null}
        </Card>
      ) : null}
      {lines.length === 0 ? (
        <EmptyState title="Nothing added yet" subtitle="Search above to add items." />
      ) : (
        lines.map((line) => {
          const opts = warehouseOptionsByItem.get(line.key) ?? [];
          const shelf = shelfByItem.get(line.key);
          const over = typeof shelf === "number" && line.qty > shelf;
          const isRental = line.source === "rental";
          return (
            <Card key={line.key}>
              <View style={s.lineRow}>
                <View style={s.lineMain}>
                  <View style={s.nameRow}>
                    <Text style={s.lineName} numberOfLines={2}>
                      {line.itemName}
                    </Text>
                    {isRental ? <RentalBadge /> : null}
                  </View>
                  <Text style={s.meta}>{line.code}</Text>
                  {isRental && line.hireEndDate ? (
                    <Text style={s.meta}>Hire ends {formatHireDate(line.hireEndDate)}</Text>
                  ) : null}
                  {typeof shelf === "number" ? (
                    <Text
                      style={[
                        s.meta,
                        { color: shelf === 0 ? colors.danger : over ? colors.warn : colors.success },
                      ]}
                    >
                      Free there: {shelf}
                      {shelf === 0
                        ? isRental
                          ? " — none free on hire"
                          : " — out of stock"
                        : over
                          ? " — less than you're asking"
                          : ""}
                    </Text>
                  ) : null}
                </View>
                <Stepper
                  value={line.qty}
                  min={1}
                  max={shelf}
                  onChange={(next) =>
                    setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, qty: next } : l)))
                  }
                />
              </View>
              {opts.length === 0 ? (
                <Text style={[s.meta, { color: colors.danger, fontWeight: "700" }]}>
                  {isRental ? "No warehouse has this free on hire" : "No warehouse has this in stock"}
                </Text>
              ) : (
                <Select
                  // A hire is collected from the DEPOT that took delivery — it can never be sourced
                  // from wherever happens to hold the most, the way company stock can — so the label
                  // names what the engineer is actually choosing between.
                  label={isRental ? "Collect from depot" : "Collect from"}
                  options={opts.map(({ key, label }) => ({ key, label }))}
                  value={effectiveWarehouses[line.key] ?? null}
                  onChange={(key) => setLineWarehouses((prev) => ({ ...prev, [line.key]: key }))}
                />
              )}
              <Button
                title="Remove"
                variant="ghost"
                small
                onPress={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
              />
            </Card>
          );
        })
      )}

      {/* Shown ONLY when the cart actually holds hired kit. The per-row depot picker above is already
          accurate; what is missing from it is that a hire is not free to go BACK anywhere — which is
          the part that costs the engineer a second trip if they learn it later. */}
      {lines.some((l) => l.source === "rental") ? (
        <Text style={s.hint}>
          Hired kit goes back to the depot it was collected from — shown on each hired item above.
        </Text>
      ) : null}

      {stops > 1 ? (
        // The engineer is the one who drives, so the cost of their own split is stated while they can
        // still change it — this used to be a reviewer's decision they learned about only after approval.
        <Card style={s.warnCard}>
          <Text style={s.warnText}>
            This request collects from {stops} warehouses — you&rsquo;ll need {stops} stops. Move a line to a
            shared warehouse if one has everything.
          </Text>
        </Card>
      ) : null}
      {availabilityError ? (
        <Card style={s.warnCard}>
          <Text style={s.warnText}>
            Couldn&rsquo;t load stock levels — warehouse counts may be unavailable. You can still send the request.
          </Text>
        </Card>
      ) : null}

      <SectionTitle>Priority</SectionTitle>
      <Segmented
        options={PRIORITY_OPTIONS}
        value={priority}
        onChange={(key) => setPriority(key as VanStockPriority)}
      />

      <SectionTitle>Details</SectionTitle>
      <Input
        label="Reason"
        required
        value={reason}
        onChangeText={setReason}
        multiline
        maxLength={2000}
        placeholder="e.g. Van consumables low — cable ties nearly out; crimping tool damaged."
      />
      <Text style={s.inputLabel}>Attachments (optional)</Text>
      <AttachmentPicker attachments={attachments} onChange={setAttachments} upload={uploadVanStockAttachment} max={10} />
      <SectionTitle>Summary</SectionTitle>
      <Card>
        {/* Empty string, not 0 — InfoRow renders it as the em dash the web summary shows before any
            line has a collection point. */}
        <InfoRow label="Collection stops" value={stops || ""} />
        <InfoRow label="Items" value={lines.length} />
        <InfoRow label="Total quantity" value={totalQty} />
        <InfoRow label="Priority" value={PRIORITY_OPTIONS.find((o) => o.key === priority)?.label ?? priority} />
      </Card>
      <ErrorText message={error} />
      <Button title="Send request" onPress={() => void submit()} loading={busy} />
    </Screen>
  );
}

const s = StyleSheet.create({
  hint: { fontSize: 13, color: colors.muted },
  searchError: { fontSize: 13, color: colors.danger },
  lineName: { fontSize: 14, fontWeight: "700", color: colors.text, flexShrink: 1 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  meta: { fontSize: 12, color: colors.muted },
  lineRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  lineMain: { flex: 1, gap: 2 },
  oosCard: { opacity: 0.55 },
  resultRight: { alignItems: "flex-end", gap: 2 },
  addedText: { fontSize: 12, fontWeight: "700", color: colors.success },
  warnCard: { borderColor: colors.warn, backgroundColor: colors.warnSoft },
  warnText: { fontSize: 13, color: colors.warn },
  warnDetail: { fontSize: 12, color: colors.warn, opacity: 0.85 },
  inputLabel: { fontSize: 13, fontWeight: "600", color: colors.muted },
});
