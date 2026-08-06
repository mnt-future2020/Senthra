import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { createKitRequest, kitItemAvailabilityFor, searchKitItems } from "@/services/kitRequest.service";
import type { KitAvailabilityMap } from "@/services/kitRequest.service";
import { getOwnJob } from "@/services/engineer.service";
import { useLoad } from "@/lib/useLoad";
import { useDebouncedCallback } from "@/lib/useDebounced";
import { useToast } from "@/lib/toast";
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  Input,
  ListSkeleton,
  Screen,
  SectionTitle,
  Stepper,
} from "@/components/ui";
import { colors } from "@/lib/theme";
import type { KitItemOption, KitRequestLinePayload } from "@/types";

interface DraftLine extends KitRequestLinePayload {
  key: string;
  detail: string;
}

interface PlannedOption {
  key: string;
  source: KitRequestLinePayload["source"];
  irmItemId?: string;
  customerStockEntryId?: string;
  itemName: string;
}

function optionKey(opt: KitItemOption): string {
  return opt.source === "irm" ? `irm:${opt.irmItemId}` : `cse:${opt.customerStockEntryId}`;
}

function customerStockDetail(opt: Extract<KitItemOption, { source: "customer_stock" }>): string {
  return `Customer stock · ${opt.warehouseName || "Stored location"}${opt.warehouseCode ? ` (${opt.warehouseCode})` : ""} · ${opt.qty} in stock${opt.serialNumber ? ` · SN ${opt.serialNumber}` : ""}`;
}

// ── Live availability (web kitItemAvailability.ts twin) ──────────────────────

const OUT_OF_STOCK = "Out of stock — no warehouse or engineer has this";
const OUT_OF_STOCK_CONSIGNMENT = "Out of stock — none of this customer's stock left here";

function availabilityParts(warehouse: number, van: number): string {
  const parts: string[] = [];
  if (warehouse > 0) parts.push(`${warehouse} in stock`);
  if (van > 0) parts.push(`${van} on another van`);
  return parts.join(" · ");
}

/** Search-row gate: figures come on the item-search response itself. */
function kitItemAvailability(opt: KitItemOption): { requestable: boolean; label: string } {
  if (opt.source === "customer_stock") {
    if ((opt.qty ?? 0) <= 0) return { requestable: false, label: OUT_OF_STOCK_CONSIGNMENT };
    // The row's own sub-line already reads "<warehouse> · N in stock".
    return { requestable: true, label: "" };
  }
  const wh = opt.quantityOnHand;
  const van = opt.heldByEngineers;
  // Fail open on a legacy/cached payload without the figures.
  if (typeof wh !== "number" || typeof van !== "number") return { requestable: true, label: "" };
  if (wh + van <= 0) return { requestable: false, label: OUT_OF_STOCK };
  return { requestable: true, label: availabilityParts(wh, van) };
}

function AvailabilityLine({
  stock,
  want,
}: {
  stock: { warehouse: number; van: number } | null;
  want: number;
}) {
  if (!stock) return null; // unknown (misc, or the advisory fetch failed) — say nothing
  const free = stock.warehouse + stock.van;
  if (free <= 0) return <Text style={s.availDanger}>None free to request</Text>;
  const parts = availabilityParts(stock.warehouse, stock.van);
  if (want > free) {
    return <Text style={s.availWarn}>{parts} — more than that isn&rsquo;t available</Text>;
  }
  return <Text style={s.availMuted}>{parts}</Text>;
}

// FE→PM additional-kit request for a live job, mirroring the web's "Request
// additional kit" modal: top up already-planned lines, search the IRM catalogue
// plus the job customer's consignment stock, or fall back to a free-text misc
// item. The PM sources each line on approval.
export default function NewKitRequestScreen() {
  const { jobId, jobNumber } = useLocalSearchParams<{ jobId: string; jobNumber?: string }>();
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KitItemOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [extras, setExtras] = useState<Record<string, number>>({});
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const searchSeq = useRef(0);

  const { data: job, loading, refreshing, refresh } = useLoad(useCallback(() => getOwnJob(jobId), [jobId]));

  // One row per distinct planned kit line (same identity merged), like the web's
  // "More of a planned item" table.
  const plannedOptions = useMemo<PlannedOption[]>(() => {
    const seen = new Map<string, PlannedOption>();
    for (const line of job?.kitLines ?? []) {
      const key =
        line.lineType === "irm" && line.irmItemId
          ? `irm:${line.irmItemId}`
          : line.lineType === "customer_stock" && line.customerStockEntryId
            ? `cse:${line.customerStockEntryId}`
            : `misc:${line.itemName.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.set(key, {
          key,
          source: line.lineType === "customer_stock" ? "customer_stock" : line.lineType === "irm" ? "irm" : "misc",
          irmItemId: line.irmItemId ?? undefined,
          customerStockEntryId: line.customerStockEntryId ?? undefined,
          itemName: line.itemName,
        });
      }
    }
    return [...seen.values()];
  }, [job]);

  const runSearch = useCallback(
    async (q: string) => {
      if (q.trim().length < 2) {
        setResults([]);
        return;
      }
      const seq = ++searchSeq.current;
      setSearching(true);
      try {
        const found = await searchKitItems(q.trim(), jobId);
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
    },
    [jobId],
  );

  const debouncedSearch = useDebouncedCallback(runSearch);

  // Live availability for planned + cart rows, refetched when the item SET
  // changes (not quantities). Advisory only — a failure just hides the lines.
  const [avail, setAvail] = useState<KitAvailabilityMap>({ irm: {}, cse: {} });
  const availSeq = useRef(0);
  const availKey = useMemo(() => {
    const irm = new Set<string>();
    const cse = new Set<string>();
    for (const p of plannedOptions) {
      if (p.source === "irm" && p.irmItemId) irm.add(p.irmItemId);
      if (p.source === "customer_stock" && p.customerStockEntryId) cse.add(p.customerStockEntryId);
    }
    for (const l of lines) {
      if (l.source === "irm" && l.irmItemId) irm.add(l.irmItemId);
      if (l.source === "customer_stock" && l.customerStockEntryId) cse.add(l.customerStockEntryId);
    }
    return JSON.stringify({ irm: [...irm].sort(), cse: [...cse].sort() });
  }, [plannedOptions, lines]);
  useEffect(() => {
    const ids = JSON.parse(availKey) as { irm: string[]; cse: string[] };
    const seq = ++availSeq.current;
    kitItemAvailabilityFor(jobId, ids.irm, ids.cse)
      .then((m) => {
        if (seq === availSeq.current) setAvail(m);
      })
      .catch(() => {
        if (seq === availSeq.current) setAvail({ irm: {}, cse: {} });
      });
  }, [availKey, jobId]);

  const stockFor = (
    source: KitRequestLinePayload["source"],
    irmItemId?: string,
    cseId?: string,
  ): { warehouse: number; van: number } | null => {
    if (source === "irm" && irmItemId) {
      const a = avail.irm[irmItemId];
      return a ? { warehouse: a.quantityOnHand, van: a.heldByEngineers } : null;
    }
    if (source === "customer_stock" && cseId) {
      const a = avail.cse[cseId];
      return a ? { warehouse: a.qty, van: 0 } : null; // consignment has no van figure by design
    }
    return null;
  };
  const freeFor = (source: KitRequestLinePayload["source"], irmItemId?: string, cseId?: string): number | null => {
    const stock = stockFor(source, irmItemId, cseId);
    return stock ? stock.warehouse + stock.van : null;
  };

  const clearSearch = () => {
    setQuery("");
    setResults([]);
    setSearchFailed(false);
    searchSeq.current++; // drop any in-flight search so it can't repopulate results
    debouncedSearch(""); // supersede any pending debounce tick
  };

  const addOption = (opt: KitItemOption) => {
    const key = optionKey(opt);
    if (!lines.some((l) => l.key === key)) {
      setLines((prev) => [
        ...prev,
        {
          key,
          source: opt.source,
          irmItemId: opt.source === "irm" ? opt.irmItemId : undefined,
          customerStockEntryId: opt.source === "customer_stock" ? opt.customerStockEntryId : undefined,
          itemName: opt.name,
          qty: 1,
          detail: opt.source === "irm" ? `IRM · ${opt.code}${opt.sku ? ` · ${opt.sku}` : ""}` : customerStockDetail(opt),
        },
      ]);
    }
    clearSearch();
  };

  const addMisc = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Web blocks the misc escape hatch when the name is already a planned line.
    if (plannedOptions.some((p) => p.itemName.toLowerCase() === trimmed.toLowerCase())) {
      setError(`“${trimmed}” is already listed above under “More of a planned item” — set its extra quantity there.`);
      return;
    }
    setError(null);
    const key = `misc:${trimmed.toLowerCase()}`;
    if (!lines.some((l) => l.key === key)) {
      setLines((prev) => [...prev, { key, source: "misc", itemName: trimmed, qty: 1, detail: "Misc (free text)" }]);
    }
    clearSearch();
  };

  const submit = async () => {
    // Merge planned-line extras and searched/misc lines, summing duplicates —
    // the web's buildLines semantics.
    const merged = new Map<string, KitRequestLinePayload>();
    for (const p of plannedOptions) {
      const qty = extras[p.key] ?? 0;
      if (qty > 0) {
        merged.set(p.key, {
          source: p.source,
          irmItemId: p.irmItemId,
          customerStockEntryId: p.customerStockEntryId,
          itemName: p.itemName,
          qty,
        });
      }
    }
    for (const l of lines) {
      const existing = merged.get(l.key);
      if (existing) existing.qty += l.qty;
      else {
        merged.set(l.key, {
          source: l.source,
          irmItemId: l.irmItemId,
          customerStockEntryId: l.customerStockEntryId,
          itemName: l.itemName,
          qty: l.qty,
        });
      }
    }
    const payloadLines = [...merged.values()];
    if (payloadLines.length === 0) {
      setError("Add at least one item with a quantity.");
      return;
    }
    if (!reason.trim()) {
      setError("Tell the planner why you need these items.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createKitRequest({ jobId, reason: reason.trim(), lines: payloadLines });
      toast.success("Request sent to the planner.");
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the request.");
    } finally {
      setBusy(false);
    }
  };

  if (loading)
    return (
      <Screen>
        <ListSkeleton count={4} />
      </Screen>
    );

  const escapeTerm = query.trim();
  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <Text style={s.hint}>
        Request extra kit for {jobNumber ?? "this job"}. The planner reviews it and decides where
        each item comes from.
      </Text>

      {plannedOptions.length > 0 ? (
        <>
          <SectionTitle>More of a planned item</SectionTitle>
          {plannedOptions.map((p) => {
            const stock = stockFor(p.source, p.irmItemId, p.customerStockEntryId);
            const free = stock ? stock.warehouse + stock.van : null;
            return (
              <Card key={p.key}>
                <View style={s.lineRow}>
                  <View style={s.lineMain}>
                    <Text style={s.lineName} numberOfLines={2}>
                      {p.itemName}
                    </Text>
                    <AvailabilityLine stock={stock} want={extras[p.key] ?? 0} />
                  </View>
                  <Stepper
                    value={extras[p.key] ?? 0}
                    min={0}
                    max={free ?? undefined}
                    onChange={(next) => setExtras((prev) => ({ ...prev, [p.key]: next }))}
                  />
                </View>
              </Card>
            );
          })}
        </>
      ) : null}

      <SectionTitle>Add another item</SectionTitle>
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
      {escapeTerm.length >= 2 && !searching && !searchFailed && results.length === 0 ? (
        <Text style={s.hint}>No matching catalogue or customer-stock item.</Text>
      ) : null}
      {results.map((opt) => {
        const key = optionKey(opt);
        const added = lines.some((l) => l.key === key);
        const availInfo = kitItemAvailability(opt);
        const locked = added || !availInfo.requestable;
        return (
          <Card key={key} onPress={locked ? undefined : () => addOption(opt)} style={locked ? s.added : undefined}>
            <Text style={s.lineName}>
              {opt.name}
              {added ? "  ✓" : ""}
            </Text>
            <Text style={s.meta}>
              {opt.source === "irm"
                ? `IRM · ${opt.code}${opt.sku ? ` · ${opt.sku}` : ""}`
                : customerStockDetail(opt)}
            </Text>
            {availInfo.label ? (
              <Text style={availInfo.requestable ? s.availMuted : s.availDanger}>{availInfo.label}</Text>
            ) : null}
          </Card>
        );
      })}
      {escapeTerm.length >= 2 && !searching ? (
        <Card onPress={() => addMisc(escapeTerm)}>
          <Text style={s.meta}>
            Can&rsquo;t find it? Add &ldquo;{escapeTerm}&rdquo; as a misc item
          </Text>
        </Card>
      ) : null}

      <SectionTitle>Requested items</SectionTitle>
      {lines.length === 0 ? (
        <EmptyState title="Nothing added yet" subtitle="Top up a planned item or search above." />
      ) : (
        lines.map((line) => {
          const stock = stockFor(line.source, line.irmItemId, line.customerStockEntryId);
          const free = freeFor(line.source, line.irmItemId, line.customerStockEntryId);
          return (
            <Card key={line.key}>
              <View style={s.lineRow}>
                <View style={s.lineMain}>
                  <Text style={s.lineName} numberOfLines={2}>
                    {line.itemName}
                  </Text>
                  <Text style={s.meta}>{line.detail}</Text>
                  <AvailabilityLine stock={stock} want={line.qty} />
                </View>
                <Stepper
                  value={line.qty}
                  min={1}
                  max={free == null ? undefined : Math.max(1, free)}
                  onChange={(next) =>
                    setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, qty: next } : l)))
                  }
                />
              </View>
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

      <Input
        label="Why do you need these?"
        required
        value={reason}
        onChangeText={setReason}
        multiline
        maxLength={2000}
        placeholder="e.g. Two cables damaged during install; need extras to finish."
      />
      <ErrorText message={error} />
      <Button title="Send request" onPress={() => void submit()} loading={busy} />
    </Screen>
  );
}

const s = StyleSheet.create({
  hint: { fontSize: 13, color: colors.muted },
  searchError: { fontSize: 13, color: colors.danger },
  availMuted: { fontSize: 11, fontWeight: "600", color: colors.muted },
  availWarn: { fontSize: 11, fontWeight: "600", color: colors.warn },
  availDanger: { fontSize: 11, fontWeight: "600", color: colors.danger },
  lineName: { fontSize: 14, fontWeight: "700", color: colors.text, flex: 1 },
  meta: { fontSize: 12, color: colors.muted },
  lineRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  lineMain: { flex: 1, gap: 2 },
  added: { opacity: 0.55 },
});
