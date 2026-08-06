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
import { AttachmentPicker } from "@/components/AttachmentPicker";
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  Input,
  Screen,
  SectionTitle,
  Segmented,
  Select,
  Stepper,
} from "@/components/ui";
import { colors } from "@/lib/theme";
import type { VanStockItemOption, VanStockPriority } from "@/types";

interface DraftLine {
  irmItemId: string;
  itemName: string;
  code: string;
  qty: number;
}

// Restock composer — request IRM items from a warehouse onto your van (non-job).
// Mirrors the web RestockComposerPage: live per-warehouse shelf counts (a
// snapshot, not a reservation), a non-blocking duplicate warning for items
// already on an open request, and image attachments.
export default function NewVanStockScreen() {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RequestableItemOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  // irmItemId → the warehouse this line is collected from. Replaces the single request-level
  // "collect from": the engineer picks per item, seeing that warehouse's free stock.
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
    if (q.trim().length < 2) {
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

  // Live shelf counts, refetched when the item SET changes (not quantities).
  const itemIdsKey = useMemo(
    () =>
      lines
        .map((l) => l.irmItemId)
        .sort()
        .join(","),
    [lines],
  );
  useEffect(() => {
    // Empty cart renders no warehouse options, so stale availability is harmless.
    if (!itemIdsKey) return;
    const seq = ++availSeq.current;
    getVanStockAvailability(itemIdsKey.split(","))
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

  const addItem = (item: VanStockItemOption) => {
    if (!lines.some((l) => l.irmItemId === item.irmItemId)) {
      setLines((prev) => [...prev, { irmItemId: item.irmItemId, itemName: item.name, code: item.code, qty: 1 }]);
    }
    setQuery("");
    setResults([]);
    setSearchFailed(false);
    searchSeq.current++; // drop any in-flight search so it can't repopulate results
    debouncedSearch(""); // supersede any pending debounce tick
  };

  const duplicates = lines.filter((l) => (openLines ?? []).some((o) => o.irmItemId === l.irmItemId));

  // Per ITEM: the warehouses that actually hold it, most stock first, each labelled with its free
  // count — the engineer's whole basis for choosing. Warehouses with none of that item are left OUT
  // rather than shown disabled: the row is about this one item, so a warehouse with none of it is
  // simply not an answer.
  const warehouseOptionsByItem = useMemo(() => {
    const map = new Map<string, { key: string; label: string; free: number }[]>();
    for (const l of lines) {
      const opts = availability
        .map((w) => {
          const free = w.items.find((i) => i.irmItemId === l.irmItemId)?.quantityOnHand ?? 0;
          const name = w.warehouseCode ? `${w.warehouseName} (${w.warehouseCode})` : w.warehouseName;
          return { key: w.warehouseId, label: `${name} — ${free} free`, free };
        })
        .filter((o) => o.free > 0)
        .sort((a, b) => b.free - a.free || a.label.localeCompare(b.label));
      map.set(l.irmItemId, opts);
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
      const opts = warehouseOptionsByItem.get(l.irmItemId) ?? [];
      const picked = lineWarehouses[l.irmItemId];
      const valid = picked && opts.some((o) => o.key === picked);
      const chosen = valid ? picked : opts[0]?.key;
      if (chosen) out[l.irmItemId] = chosen;
    }
    return out;
  }, [lines, warehouseOptionsByItem, lineWarehouses]);

  // How many separate places this request sends the engineer to. Shown while it can still be changed.
  const stops = useMemo(() => new Set(Object.values(effectiveWarehouses)).size, [effectiveWarehouses]);
  const unplaced = lines.filter((l) => !effectiveWarehouses[l.irmItemId]);

  // Free stock at the warehouse THIS line is collected from — the cap the qty stepper is judged against.
  const shelfByItem = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lines) {
      const whId = effectiveWarehouses[l.irmItemId];
      if (!whId) continue;
      const free = availability
        .find((a) => a.warehouseId === whId)
        ?.items.find((i) => i.irmItemId === l.irmItemId)?.quantityOnHand;
      if (typeof free === "number") m.set(l.irmItemId, free);
    }
    return m;
  }, [availability, lines, effectiveWarehouses]);

  // Switching a line to a warehouse with less stock leaves an already-set qty above the new cap
  // (clamping it silently would rewrite a number the engineer chose), so it's caught here instead.
  const overCap = lines.find((l) => {
    const free = shelfByItem.get(l.irmItemId);
    return typeof free === "number" && l.qty > free;
  });

  const submit = async () => {
    if (lines.length === 0) {
      setError("Add at least one item.");
      return;
    }
    if (overCap) {
      const free = shelfByItem.get(overCap.irmItemId) ?? 0;
      setError(
        `Only ${free} of "${overCap.itemName}" are free at the warehouse you picked — lower the quantity or collect it from somewhere else.`,
      );
      return;
    }
    if (unplaced.length > 0) {
      // Only reachable when an item is stocked NOWHERE (auto-select fills every other case).
      setError(`No warehouse has "${unplaced[0]!.itemName}" in stock — remove it or ask the office to order it.`);
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
        lines: lines.map((l) => ({
          irmItemId: l.irmItemId,
          itemName: l.itemName,
          qty: l.qty,
          warehouseId: effectiveWarehouses[l.irmItemId]!,
        })),
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
      <Input
        placeholder="Search the item you need…"
        value={query}
        onChangeText={(v) => {
          setQuery(v);
          debouncedSearch(v);
        }}
        autoCapitalize="none"
      />
      {searching ? <Text style={s.hint}>Searching…</Text> : null}
      {searchFailed ? (
        <Text style={s.searchError}>Couldn&rsquo;t run the search just now. Check your connection and try again.</Text>
      ) : null}
      {query.trim().length >= 2 && !searching && !searchFailed && results.length === 0 ? (
        <Text style={s.hint}>No matching item in the catalogue.</Text>
      ) : null}
      {results.map((item) => {
        // Out of stock at EVERY warehouse — no warehouse can fulfil it, so show it (the engineer sees
        // the item exists) but don't let it be added. Mirrors the web restock composer.
        const outOfStock = item.quantityOnHand <= 0;
        return (
          <Card
            key={item.irmItemId}
            onPress={outOfStock ? undefined : () => addItem(item)}
            style={outOfStock ? s.oosCard : undefined}
          >
            <View style={s.lineRow}>
              <View style={s.lineMain}>
                <Text style={s.lineName}>{item.name}</Text>
                <Text style={s.meta}>
                  {item.code}
                  {item.sku ? ` · ${item.sku}` : ""}
                  {item.uom ? ` · ${item.uom}` : ""}
                </Text>
              </View>
              <Text style={[s.meta, { fontWeight: "700", color: outOfStock ? colors.danger : colors.success }]}>
                {outOfStock ? "Out of stock" : `${item.quantityOnHand} in stock`}
              </Text>
            </View>
          </Card>
        );
      })}

      <SectionTitle>{lines.length ? `Selected items (${lines.length})` : "Selected items"}</SectionTitle>
      <Text style={s.hint}>Set the quantity, and where you&rsquo;ll collect each item from.</Text>
      {duplicates.length > 0 ? (
        <Card style={s.warnCard}>
          <Text style={s.warnText}>
            Heads up — you already have an open request for:{" "}
            {duplicates.map((d) => `${d.itemName} (${d.code})`).join(", ")}. You can still send this one.
          </Text>
        </Card>
      ) : null}
      {lines.length === 0 ? (
        <EmptyState title="Nothing added yet" subtitle="Search above to add items." />
      ) : (
        lines.map((line) => {
          const opts = warehouseOptionsByItem.get(line.irmItemId) ?? [];
          const shelf = shelfByItem.get(line.irmItemId);
          const over = typeof shelf === "number" && line.qty > shelf;
          return (
            <Card key={line.irmItemId}>
              <View style={s.lineRow}>
                <View style={s.lineMain}>
                  <Text style={s.lineName} numberOfLines={2}>
                    {line.itemName}
                  </Text>
                  <Text style={s.meta}>{line.code}</Text>
                  {typeof shelf === "number" ? (
                    <Text
                      style={[
                        s.meta,
                        { color: shelf === 0 ? colors.danger : over ? colors.warn : colors.success },
                      ]}
                    >
                      Free there: {shelf}
                      {shelf === 0 ? " — out of stock" : over ? " — less than you're asking" : ""}
                    </Text>
                  ) : null}
                </View>
                <Stepper
                  value={line.qty}
                  min={1}
                  max={shelf}
                  onChange={(next) =>
                    setLines((prev) => prev.map((l) => (l.irmItemId === line.irmItemId ? { ...l, qty: next } : l)))
                  }
                />
              </View>
              {opts.length === 0 ? (
                <Text style={[s.meta, { color: colors.danger, fontWeight: "700" }]}>
                  No warehouse has this in stock
                </Text>
              ) : (
                <Select
                  label="Collect from"
                  options={opts.map(({ key, label }) => ({ key, label }))}
                  value={effectiveWarehouses[line.irmItemId] ?? null}
                  onChange={(key) => setLineWarehouses((prev) => ({ ...prev, [line.irmItemId]: key }))}
                />
              )}
              <Button
                title="Remove"
                variant="ghost"
                small
                onPress={() => setLines((prev) => prev.filter((l) => l.irmItemId !== line.irmItemId))}
              />
            </Card>
          );
        })
      )}

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
        options={[
          { key: "normal", label: "Normal" },
          { key: "high", label: "High" },
          { key: "urgent", label: "Urgent" },
        ]}
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
      <ErrorText message={error} />
      <Button title="Send request" onPress={() => void submit()} loading={busy} />
    </Screen>
  );
}

const s = StyleSheet.create({
  hint: { fontSize: 13, color: colors.muted },
  searchError: { fontSize: 13, color: colors.danger },
  lineName: { fontSize: 14, fontWeight: "700", color: colors.text },
  meta: { fontSize: 12, color: colors.muted },
  lineRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  lineMain: { flex: 1, gap: 2 },
  oosCard: { opacity: 0.55 },
  warnCard: { borderColor: colors.warn, backgroundColor: colors.warnSoft },
  warnText: { fontSize: 13, color: colors.warn },
  inputLabel: { fontSize: 13, fontWeight: "600", color: colors.muted },
});
