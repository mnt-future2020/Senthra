import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  createVanStockRequest,
  getVanStockAvailability,
  myOpenLineItems,
  searchVanStockItems,
  uploadVanStockAttachment,
} from "@/services/vanStock.service";
import type { WarehouseAvailability } from "@/services/vanStock.service";
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
  const [results, setResults] = useState<VanStockItemOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
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
  const { data: openLines } = useLoad(useCallback(() => myOpenLineItems("restock"), []));

  const runSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    try {
      const found = await searchVanStockItems(q.trim());
      if (seq === searchSeq.current) setResults(found);
    } catch {
      if (seq === searchSeq.current) setResults([]);
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
  }, [itemIdsKey]);

  const addItem = (item: VanStockItemOption) => {
    if (!lines.some((l) => l.irmItemId === item.irmItemId)) {
      setLines((prev) => [...prev, { irmItemId: item.irmItemId, itemName: item.name, code: item.code, qty: 1 }]);
    }
    setQuery("");
    setResults([]);
    searchSeq.current++; // drop any in-flight search so it can't repopulate results
    debouncedSearch(""); // supersede any pending debounce tick
  };

  const duplicates = lines.filter((l) => (openLines ?? []).some((o) => o.irmItemId === l.irmItemId));

  // Warehouse options ranked by how many cart items they have on the shelf.
  const warehouseOptions = useMemo(() => {
    return availability
      .map((w) => {
        const inStock = lines.filter(
          (l) => (w.items.find((i) => i.irmItemId === l.irmItemId)?.quantityOnHand ?? 0) > 0,
        ).length;
        return { ...w, inStock };
      })
      .sort((a, b) => b.inStock - a.inStock)
      .map((w) => ({
        key: w.warehouseId,
        label: `${w.warehouseName}${w.warehouseCode ? ` (${w.warehouseCode})` : ""} — ${w.inStock}/${lines.length} in stock`,
      }));
  }, [availability, lines]);

  const shelfCount = (irmItemId: string): number | null => {
    if (!warehouseId) return null;
    const w = availability.find((a) => a.warehouseId === warehouseId);
    if (!w) return null;
    return w.items.find((i) => i.irmItemId === irmItemId)?.quantityOnHand ?? 0;
  };

  const submit = async () => {
    if (lines.length === 0) {
      setError("Add at least one item.");
      return;
    }
    if (!warehouseId) {
      setError("Pick the warehouse you'll collect from.");
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
        preferredWarehouseId: warehouseId,
        attachments: attachments.length ? attachments : undefined,
        lines: lines.map((l) => ({ irmItemId: l.irmItemId, itemName: l.itemName, qty: l.qty })),
      });
      toast.success("Restock request sent to the warehouse.");
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the request.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Text style={s.hint}>
        The warehouse reviews, confirms the fulfilment warehouse and scans it out to you.
      </Text>

      <SectionTitle>Add items</SectionTitle>
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
      {results.map((item) => (
        <Card key={item.irmItemId} onPress={() => addItem(item)}>
          <Text style={s.lineName}>{item.name}</Text>
          <Text style={s.meta}>
            {item.code}
            {item.sku ? ` · ${item.sku}` : ""}
            {item.uom ? ` · ${item.uom}` : ""}
          </Text>
        </Card>
      ))}

      <SectionTitle>Selected items ({lines.length})</SectionTitle>
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
          const shelf = shelfCount(line.irmItemId);
          return (
            <Card key={line.irmItemId}>
              <View style={s.lineRow}>
                <View style={s.lineMain}>
                  <Text style={s.lineName} numberOfLines={2}>
                    {line.itemName}
                  </Text>
                  <Text style={s.meta}>{line.code}</Text>
                  {shelf !== null ? (
                    <Text
                      style={[
                        s.meta,
                        { color: shelf === 0 ? colors.danger : shelf < line.qty ? colors.warn : colors.success },
                      ]}
                    >
                      On shelf there: {shelf}
                      {shelf === 0
                        ? " — out of stock at that warehouse"
                        : shelf < line.qty
                          ? " — less than you're asking"
                          : ""}
                    </Text>
                  ) : null}
                </View>
                <Stepper
                  value={line.qty}
                  min={1}
                  onChange={(next) =>
                    setLines((prev) => prev.map((l) => (l.irmItemId === line.irmItemId ? { ...l, qty: next } : l)))
                  }
                />
              </View>
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

      <SectionTitle>Collection &amp; priority</SectionTitle>
      <Text style={s.hint}>
        Your request goes to that warehouse&rsquo;s team — they confirm (or change) it on approval.
      </Text>
      {availabilityError ? (
        <Text style={s.hint}>
          Couldn&rsquo;t load stock levels — warehouse counts may be unavailable. You can still send the request.
        </Text>
      ) : null}
      {lines.length === 0 ? (
        <Text style={s.hint}>Add items first to see stock…</Text>
      ) : (
        <>
          <Select
            label="Collect from"
            required
            options={warehouseOptions}
            value={warehouseId}
            onChange={setWarehouseId}
            placeholder="Pick a warehouse…"
          />
          <Text style={s.hint}>Stock counts are a live snapshot, not a reservation.</Text>
        </>
      )}

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
  lineName: { fontSize: 14, fontWeight: "700", color: colors.text },
  meta: { fontSize: 12, color: colors.muted },
  lineRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  lineMain: { flex: 1, gap: 2 },
  warnCard: { borderColor: colors.warn, backgroundColor: colors.warnSoft },
  warnText: { fontSize: 13, color: colors.warn },
  inputLabel: { fontSize: 13, fontWeight: "600", color: colors.muted },
});
