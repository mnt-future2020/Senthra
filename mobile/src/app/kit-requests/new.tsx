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
  SearchInput,
  RentalBadge,
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
  rentalItemId?: string;
  customerStockEntryId?: string;
  itemName: string;
}

function optionKey(opt: KitItemOption): string {
  // Three-way. The binary form treated everything that was not IRM as customer stock, so a rental
  // option keyed `cse:undefined` — colliding with every other rental in the list.
  if (opt.source === "irm") return `irm:${opt.irmItemId}`;
  if (opt.source === "rental") return `rental:${opt.rentalItemId}`;
  return `cse:${opt.customerStockEntryId}`;
}

/**
 * One-line label for a rental option: "RNT-0007 · Leeds +1 more · 4 available to issue".
 *
 * "Available to issue", NOT "free on hire" — the same phrasing rentalAvailabilityParts uses on the
 * stepper sub-line below. The two sit on one screen describing one figure, and worded differently
 * they read as two different facts. It is also the accurate claim: the server excludes hires whose
 * period has ended, so this is what could go out today.
 */
function rentalDetail(opt: Extract<KitItemOption, { source: "rental" }>): string {
  if (opt.depots.length === 0) return `${opt.code} · none available to issue`;
  const [first, ...rest] = opt.depots;
  const where = `${first.warehouseName ?? "Depot"}${rest.length ? ` +${rest.length} more` : ""}`;
  return `${opt.code} · ${where} · ${opt.quantityOnHand} available to issue`;
}

// "Warehouse (CODE) · N in stock · SN ...". Falls back to "Stored location" when the warehouse name
// is missing, so the label never starts with a stray separator.
function customerStockDetail(opt: Extract<KitItemOption, { source: "customer_stock" }>): string {
  const where = opt.warehouseName
    ? `${opt.warehouseName}${opt.warehouseCode ? ` (${opt.warehouseCode})` : ""}`
    : "Stored location";
  return `${where} · ${opt.qty} in stock${opt.serialNumber ? ` · SN ${opt.serialNumber}` : ""}`;
}

// ── Live availability (web kitItemAvailability.ts twin) ──────────────────────

const OUT_OF_STOCK = "Out of stock — no warehouse or engineer has this";
const OUT_OF_STOCK_CONSIGNMENT = "Out of stock — none of this customer's stock left here";
// A hire is not "out of stock", it is NOT CURRENTLY HIRED — and the fix is a purchase request, not
// a wait. Naming an engineer here would point at a source hired kit can never come from.
const OUT_OF_STOCK_RENTAL = "None on hire — raise a purchase request to hire one";

function availabilityParts(warehouse: number, van: number): string {
  const parts: string[] = [];
  if (warehouse > 0) parts.push(`${warehouse} in stock`);
  if (van > 0) parts.push(`${van} on another van`);
  return parts.join(" · ");
}

/**
 * The same sentence for HIRED equipment, which is deliberately not the one above.
 *
 * "In stock" is untrue of a rental: it is not our stock, it is somebody else's equipment we are
 * paying to hold, and the figure is bounded by a hire period rather than by what we own. This row
 * used to read "23 in stock" for a fibre tester while the search list above it said "available to
 * issue" for the very same item — the screen contradicting itself.
 *
 * The depot is named because a hire is collected from the depot that took delivery and can never be
 * transferred off a colleague's van, so "where" is not optional context the way it is for owned
 * stock. Capped at one name plus a count: this is a sub-line under a stepper, and an engineer with
 * kit at five depots needs to know there is a choice, not read the list.
 */
function rentalAvailabilityParts(
  free: number,
  depots: readonly { warehouseName: string | null }[] = [],
): string {
  if (free <= 0) return OUT_OF_STOCK_RENTAL;
  const [first, ...rest] = depots;
  const where = first ? `${first.warehouseName ?? "Depot"}${rest.length ? ` +${rest.length} more` : ""}` : "";
  return `Available to issue: ${free}${where ? ` · ${where}` : ""}`;
}

/**
 * A requested quantity clamped to what is actually free (web kitRequestQty.ts
 * twin). Clamped at READ time — the number on screen and in the payload are the
 * same by construction. `free === null` stays uncapped (misc lines, or a failed
 * advisory lookup — approve() re-checks before stock moves). `free <= 0`
 * returns 0 and IGNORES `min`: the obvious max(min, min(qty, free)) returns 1
 * for a cart row with nothing free, so a row reading "None free to request"
 * still shipped a quantity of 1 to the planner. A zero here fails the qty > 0
 * check and the line drops out of the request.
 */
function capQty(qty: number, free: number | null, min = 0): number {
  if (free === null) return qty;
  if (free <= 0) return 0;
  return Math.max(min, Math.min(qty, free));
}

/** Search-row gate: figures come on the item-search response itself. */
function kitItemAvailability(opt: KitItemOption): { requestable: boolean; label: string } {
  if (opt.source === "rental") {
    // Depot-only. Falling through to the IRM branch below would give the right NUMBER (its van figure
    // is structurally 0) and the wrong SENTENCE: "no warehouse or engineer has this" points an
    // engineer at a source hired kit can never come from.
    if ((opt.quantityOnHand ?? 0) <= 0) return { requestable: false, label: OUT_OF_STOCK_RENTAL };
    // The row's own sub-line already reads "Rental · RNT-#### · <depot> · N free on hire".
    return { requestable: true, label: "" };
  }
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

/**
 * What a composer row knows about where its stock is.
 *
 * `depots` is present ONLY for hired equipment and doubles as the discriminator: owned stock and
 * consignment have no hire behind them, so a row carrying depots is a rental and must be described
 * as "available to issue" rather than as stock we hold.
 */
interface Stock {
  warehouse: number;
  van: number;
  depots?: readonly { warehouseName: string | null }[];
}

function PoolBadge({ label, tone }: { label: string; tone: "accent" | "muted" }) {
  return (
    <View style={[s.poolBadge, tone === "accent" ? s.poolBadgeAccent : s.poolBadgeMuted]}>
      <Text style={[s.poolBadgeText, { color: tone === "accent" ? colors.accent : colors.faint }]}>{label}</Text>
    </View>
  );
}

function AvailabilityLine({ stock, want }: { stock: Stock | null; want: number }) {
  if (!stock) return null; // unknown (misc, or the advisory fetch failed) — say nothing
  const free = stock.warehouse + stock.van;
  if (free <= 0) return <Text style={s.availDanger}>None free to request</Text>;
  // Hired equipment gets its own sentence — `depots` marks the row. Without this the line read
  // "23 in stock" for a fibre tester: false twice over, and contradicting the search row above it.
  const parts = stock.depots
    ? rentalAvailabilityParts(free, stock.depots)
    : availabilityParts(stock.warehouse, stock.van);
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
          : line.lineType === "rental" && line.rentalItemId
            ? `rental:${line.rentalItemId}`
            : line.lineType === "customer_stock" && line.customerStockEntryId
              ? `cse:${line.customerStockEntryId}`
              // Trimmed, like the web's key — otherwise a planned misc line with stray whitespace
              // keys differently from the one the escape hatch below builds, and the collision guard
              // in addMisc misses it.
              : `misc:${line.itemName.trim().toLowerCase()}`;
      if (!seen.has(key)) {
        seen.set(key, {
          key,
          // Chained ternary ending in "misc" — a rental line landed in that else and was offered to
          // the planner as free text with its id dropped.
          source:
            line.lineType === "customer_stock"
              ? "customer_stock"
              : line.lineType === "irm"
                ? "irm"
                : line.lineType === "rental"
                  ? "rental"
                  : "misc",
          irmItemId: line.irmItemId ?? undefined,
          rentalItemId: line.rentalItemId ?? undefined,
          customerStockEntryId: line.customerStockEntryId ?? undefined,
          itemName: line.itemName,
        });
      }
    }
    return [...seen.values()];
  }, [job]);

  const runSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setResults([]);
        setSearchFailed(false);
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
  // The figures TOGETHER WITH the item set they describe. Stapling the key on is what lets "still
  // loading" be derived rather than stored: "no figure yet" and "no figure at all" both read as
  // `free == null`, and the latter must stay UNCAPPED (misc lines, or a failed lookup — never cap on
  // a guess). Without the distinction a quantity typed in the moment before the numbers landed went
  // in uncapped, which is how a row reading "None free to request" could still submit 1.
  const [availState, setAvailState] = useState<{ key: string; data: KitAvailabilityMap }>({
    key: "",
    data: { irm: {}, cse: {}, rental: {} },
  });
  const availSeq = useRef(0);
  const availKey = useMemo(() => {
    const irm = new Set<string>();
    const cse = new Set<string>();
    const rental = new Set<string>();
    for (const p of plannedOptions) {
      if (p.source === "irm" && p.irmItemId) irm.add(p.irmItemId);
      if (p.source === "rental" && p.rentalItemId) rental.add(p.rentalItemId);
      if (p.source === "customer_stock" && p.customerStockEntryId) cse.add(p.customerStockEntryId);
    }
    for (const l of lines) {
      if (l.source === "irm" && l.irmItemId) irm.add(l.irmItemId);
      if (l.source === "rental" && l.rentalItemId) rental.add(l.rentalItemId);
      if (l.source === "customer_stock" && l.customerStockEntryId) cse.add(l.customerStockEntryId);
    }
    return JSON.stringify({ irm: [...irm].sort(), cse: [...cse].sort(), rental: [...rental].sort() });
  }, [plannedOptions, lines]);
  useEffect(() => {
    const key = availKey;
    const ids = JSON.parse(key) as { irm: string[]; cse: string[]; rental: string[] };
    const seq = ++availSeq.current;
    kitItemAvailabilityFor(jobId, ids.irm, ids.cse, ids.rental)
      .then((m) => {
        if (seq === availSeq.current) setAvailState({ key, data: m });
      })
      // Advisory only — losing it must never block the request. The steppers simply go uncapped and
      // approve() still re-checks before any stock moves. Tagged with the key either way, so a
      // failed lookup settles into "known-unknown" rather than looking like it is still loading.
      .catch(() => {
        if (seq === availSeq.current) setAvailState({ key, data: { irm: {}, cse: {}, rental: {} } });
      });
  }, [availKey, jobId]);

  // Derived, not stored: the answer we hold doesn't describe the item set we're showing.
  const availLoading = availState.key !== availKey;
  const avail = availState.data;

  const stockFor = (
    source: KitRequestLinePayload["source"],
    irmItemId?: string,
    cseId?: string,
    rentalItemId?: string,
  ): Stock | null => {
    if (source === "irm" && irmItemId) {
      const a = avail.irm[irmItemId];
      return a ? { warehouse: a.quantityOnHand, van: a.heldByEngineers } : null;
    }
    if (source === "rental" && rentalItemId) {
      const a = avail.rental[rentalItemId];
      // van is structurally 0 — hired kit never comes off a colleague's van. `depots` rides along so
      // the sub-line can NAME where the kit is, and so AvailabilityLine knows not to describe it as
      // stock we own.
      return a ? { warehouse: a.quantityOnHand, van: 0, depots: a.depots } : null;
    }
    if (source === "customer_stock" && cseId) {
      const a = avail.cse[cseId];
      return a ? { warehouse: a.qty, van: 0 } : null; // consignment has no van figure by design
    }
    return null;
  };
  const freeFor = (source: KitRequestLinePayload["source"], irmItemId?: string, cseId?: string, rentalItemId?: string): number | null => {
    const stock = stockFor(source, irmItemId, cseId, rentalItemId);
    return stock ? stock.warehouse + stock.van : null;
  };

  // A row is held only while ITS OWN figure is outstanding. `availLoading` alone would freeze every
  // stepper on the request each time the item set changes — and it changes on every add/remove, so
  // adding a second item would lock the first item's stepper too. Rows we already have an answer for
  // keep working through the refetch; rows with no figure AT ALL (misc, or a settled failure) were
  // never capped in the first place and stay editable.
  const qtyPending = (
    source: KitRequestLinePayload["source"],
    irmItemId?: string,
    cseId?: string,
    rentalItemId?: string,
  ): boolean => availLoading && freeFor(source, irmItemId, cseId, rentalItemId) === null && source !== "misc";

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
          rentalItemId: opt.source === "rental" ? opt.rentalItemId : undefined,
          customerStockEntryId: opt.source === "customer_stock" ? opt.customerStockEntryId : undefined,
          itemName: opt.name,
          qty: 1,
          // Three-way. The binary form sent every non-IRM option through customerStockDetail, which
          // reads fields a rental option does not have.
          detail:
            opt.source === "irm"
              ? opt.code
              : opt.source === "rental"
                ? rentalDetail(opt)
                : customerStockDetail(opt),
        },
      ]);
    }
    // The results STAY, and the added row marks itself below — the web's `excludeKeys` behaviour.
    // Only the misc escape hatch resets the box (web's `reset()` on onAddCustom).
  };

  const addMisc = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Keyed, not name-matched. A planned IRM item that happens to share a name is a DIFFERENT
    // thing from a free-text row, and only a planned misc line would have its quantity silently
    // merged on submit — which is the collision this guard exists to prevent.
    if (plannedOptions.some((p) => p.key === `misc:${trimmed.toLowerCase()}`)) {
      setError(`“${trimmed}” is already listed above under “More of a planned item” — set its extra quantity there.`);
      return;
    }
    setError(null);
    const key = `misc:${trimmed.toLowerCase()}`;
    if (!lines.some((l) => l.key === key)) {
      setLines((prev) => [...prev, { key, source: "misc", itemName: trimmed, qty: 1, detail: "" }]);
    }
    clearSearch();
  };

  const submit = async () => {
    // Merge planned-line extras and searched/misc lines, summing duplicates —
    // the web's buildLines semantics.
    const merged = new Map<string, KitRequestLinePayload>();
    for (const p of plannedOptions) {
      const qty = capQty(extras[p.key] ?? 0, freeFor(p.source, p.irmItemId, p.customerStockEntryId, p.rentalItemId), 0);
      if (qty > 0) {
        merged.set(p.key, {
          source: p.source,
          irmItemId: p.irmItemId,
          // Carried explicitly. The payload literal named exactly three identity fields, so a rental
          // line went to the server with its source set but no id — which the API refuses, and which
          // the engineer could not have diagnosed from the screen.
          rentalItemId: p.rentalItemId,
          customerStockEntryId: p.customerStockEntryId,
          itemName: p.itemName,
          qty,
        });
      }
    }
    // Rows we could not classify. A bare catch-all used to submit anything that was not irm /
    // customer_stock — a rental, or an irm row that had somehow lost its id — as free text: item id
    // gone, no custody, and the API accepting it without complaint. A request that silently becomes
    // something else is worse than one that refuses to send.
    const unresolved: string[] = [];
    for (const l of lines) {
      // A cart row with nothing free drops out (capQty → 0) rather than
      // shipping the floor of 1 alongside "None free to request".
      const qty = capQty(l.qty, freeFor(l.source, l.irmItemId, l.customerStockEntryId, l.rentalItemId), 1);
      if (qty <= 0) continue;
      const identified =
        (l.source === "irm" && l.irmItemId) ||
        (l.source === "rental" && l.rentalItemId) ||
        (l.source === "customer_stock" && l.customerStockEntryId) ||
        l.source === "misc";
      if (!identified) {
        unresolved.push(l.itemName);
        continue;
      }
      const existing = merged.get(l.key);
      if (existing) existing.qty += qty;
      else {
        merged.set(l.key, {
          source: l.source,
          irmItemId: l.irmItemId,
          rentalItemId: l.rentalItemId,
          customerStockEntryId: l.customerStockEntryId,
          itemName: l.itemName,
          qty,
        });
      }
    }
    if (unresolved.length > 0) {
      setError(
        `Couldn't work out where to source: ${unresolved.join(", ")}. Remove ${unresolved.length === 1 ? "it" : "them"} and search again.`,
      );
      return;
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
            const stock = stockFor(p.source, p.irmItemId, p.customerStockEntryId, p.rentalItemId);
            const free = stock ? stock.warehouse + stock.van : null;
            // Clamped at read time so the number on screen IS the payload number.
            const shown = capQty(extras[p.key] ?? 0, free, 0);
            return (
              <Card key={p.key}>
                <View style={s.lineRow}>
                  <View style={s.lineMain}>
                    <Text style={s.lineName} numberOfLines={2}>
                      {p.itemName}
                    </Text>
                    <AvailabilityLine stock={stock} want={shown} />
                  </View>
                  <Stepper
                    value={shown}
                    min={0}
                    max={free ?? undefined}
                    disabled={qtyPending(p.source, p.irmItemId, p.customerStockEntryId, p.rentalItemId)}
                    onChange={(next) => setExtras((prev) => ({ ...prev, [p.key]: next }))}
                  />
                </View>
              </Card>
            );
          })}
        </>
      ) : null}

      <SectionTitle>Add another item</SectionTitle>
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
      {escapeTerm.length > 0 && !searching && !searchFailed && results.length === 0 ? (
        <Text style={s.hint}>No matching catalogue, rental or customer-stock item.</Text>
      ) : null}
      {results.map((opt) => {
        const key = optionKey(opt);
        const added = lines.some((l) => l.key === key);
        const availInfo = kitItemAvailability(opt);
        const locked = added || !availInfo.requestable;
        return (
          <Card key={key} onPress={locked ? undefined : () => addOption(opt)} style={locked ? s.added : undefined}>
            <View style={s.nameRow}>
              <Text style={s.lineName} numberOfLines={2}>
                {opt.name}
              </Text>
              {opt.source === "rental" ? <RentalBadge /> : null}
              {opt.source === "customer_stock" ? <PoolBadge label="Customer stock" tone="accent" /> : null}
              {added ? <Text style={s.addedText}>✓</Text> : null}
            </View>
            <Text style={s.meta}>
              {opt.source === "irm"
                ? opt.code
                : opt.source === "rental"
                  ? rentalDetail(opt)
                  : customerStockDetail(opt)}
            </Text>
            {availInfo.label ? (
              <Text style={availInfo.requestable ? s.availMuted : s.availDanger}>{availInfo.label}</Text>
            ) : null}
          </Card>
        );
      })}
      {escapeTerm.length > 0 && !searching ? (
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
          const stock = stockFor(line.source, line.irmItemId, line.customerStockEntryId, line.rentalItemId);
          const free = freeFor(line.source, line.irmItemId, line.customerStockEntryId, line.rentalItemId);
          // Clamped at read time so the number on screen IS the payload number —
          // a row with nothing free shows 0 and drops out of the request.
          const shown = capQty(line.qty, free, 1);
          return (
            <Card key={line.key}>
              <View style={s.lineRow}>
                <View style={s.lineMain}>
                  <View style={s.nameRow}>
                    <Text style={s.lineName} numberOfLines={2}>
                      {line.itemName}
                    </Text>
                    {line.source === "misc" ? <PoolBadge label="Misc" tone="muted" /> : null}
                    {line.source === "customer_stock" ? (
                      <PoolBadge label="Customer stock" tone="accent" />
                    ) : null}
                  </View>
                  {line.detail ? <Text style={s.meta}>{line.detail}</Text> : null}
                  <AvailabilityLine stock={stock} want={shown} />
                </View>
                <Stepper
                  value={shown}
                  // Follows the cap rather than sitting at a flat 1: with nothing free the row is
                  // legitimately 0 (and drops out of the request), and a stepper showing 0 with a
                  // floor of 1 is a control that contradicts itself.
                  min={free === 0 ? 0 : 1}
                  max={free ?? undefined}
                  disabled={qtyPending(line.source, line.irmItemId, line.customerStockEntryId, line.rentalItemId)}
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
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  addedText: { fontSize: 13, fontWeight: "800", color: colors.success },
  poolBadge: { borderRadius: 4, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 1 },
  poolBadgeAccent: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  poolBadgeMuted: { borderColor: colors.border, backgroundColor: colors.card },
  poolBadgeText: { fontSize: 9, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
});
