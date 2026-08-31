import React, { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  createVanStockRequest,
  listWarehousesLite,
  myHoldings,
  myOpenLineItems,
} from "@/services/vanStock.service";
import { useLoad } from "@/lib/useLoad";
import { useToast } from "@/lib/toast";
import { openLineAdvisory } from "@/lib/openLineAdvisory";
import { toLinePayload, vanStockItemKey } from "@/lib/vanStockLine";
import {
  canAddRental,
  effectiveReturnWarehouse,
  refusedRentalRows,
  returnDepotFor,
  returnWarehouseOptions,
  unitsAtDepot,
} from "@/lib/returnDepot";
import { formatHireDate } from "@/lib/format";
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  InfoRow,
  Input,
  ListSkeleton,
  RentalBadge,
  Screen,
  SectionTitle,
  Select,
  Stepper,
} from "@/components/ui";
import { colors } from "@/lib/theme";

// Return composer — hand stock from your van back to a warehouse.
// No approval step: the warehouse scanning the stock in IS the acceptance.
//
// TWO POOLS, like the restock composer. Company stock is ours and goes back to any warehouse. HIRED
// kit is not: it is somebody else's equipment, it keeps billing until it is back, and it is owed to
// the depot that took delivery — so each hired row names where it came from and leads with its
// deadline. Rows are keyed by the COMPOSITE item key throughout: the two catalogues have independent
// id spaces, so a bare id could collide a tester with a cable.
export default function ReturnVanStockScreen() {
  const router = useRouter();
  const toast = useToast();
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const {
    data: holdings,
    loading,
    refreshing,
    refresh: refreshHoldings,
    error: holdingsError,
  } = useLoad(useCallback(() => myHoldings(), []));
  const { data: warehouses, error: warehousesError, reload: reloadWarehouses } = useLoad(
    useCallback(() => listWarehousesLite(), []),
  );
  // Advisory duplicate guard — items already on my OPEN returns.
  const { data: openLines, reload: reloadOpenLines } = useLoad(useCallback(() => myOpenLineItems("return"), []));

  const openKeys = useMemo(
    () => new Map((openLines ?? []).map((o) => [vanStockItemKey(o), o.code])),
    [openLines],
  );
  // Only rows the engineer has actually put a quantity against — an untouched holding that happens to
  // be on an open return is not something they are doing anything about yet.
  const picked = useMemo(
    () => (holdings ?? []).filter((h) => (quantities[vanStockItemKey(h)] ?? 0) > 0),
    [holdings, quantities],
  );
  const totalQty = picked.reduce((n, h) => n + (quantities[vanStockItemKey(h)] ?? 0), 0);

  // WHERE THIS RETURN GOES, decided from the staged rows rather than asked for. Hired kit must go
  // back to the warehouse of its own order (the model cannot record it coming back elsewhere, and the
  // server refuses it at create/scan/post), so once a hire is staged the destination is a consequence,
  // not a choice. Company stock keeps the free picker it has always had. See lib/returnDepot.ts.
  const depot = useMemo(() => returnDepotFor(picked), [picked]);
  const warehouseOptions = useMemo(
    () =>
      returnWarehouseOptions(
        depot,
        (warehouses ?? []).map((w) => ({ key: w.id, label: w.code ? `${w.name} (${w.code})` : w.name })),
      ),
    [warehouses, depot],
  );
  // DERIVED, never copied into state. A hire fixes it; a multi-depot set keeps the engineer's pick
  // only while the rows still permit it; an IRM-only return is whatever they chose. Un-staging the
  // last hire therefore hands the field straight back to a normal picker with no stale value to clear.
  const effectiveWarehouseId = effectiveReturnWarehouse(depot, warehouseId ?? "");
  const returnWarehouseLabel =
    warehouseOptions.find((o) => o.key === effectiveWarehouseId)?.label ??
    (warehouses ?? []).find((w) => w.id === effectiveWarehouseId)?.name ??
    "";

  // WHY A ROW IS GREYED OUT — answered for every row BEFORE it is tapped, so the reason can sit ON
  // the row. A refusal the engineer only meets after tapping is one they have to go looking for, and
  // on a phone the foot of the form is off screen.
  const blockedRows = useMemo(
    () => refusedRentalRows(picked, holdings ?? [], vanStockItemKey, (key) => (quantities[key] ?? 0) > 0),
    [picked, holdings, quantities],
  );

  // One counter, one depot's units. A hired row's quantity is summed across every hire its units sit
  // on, and those hires can be at different depots — 2 at Bristol and 3 at Leeds is a row of 5 that
  // is postable to NEITHER. Capped here so the unpostable number cannot be stepped to.
  const capFor = (h: (typeof picked)[number]): number => {
    const atDepot = unitsAtDepot(h, effectiveWarehouseId);
    return atDepot === null ? h.quantityOnHand : Math.min(h.quantityOnHand, atDepot);
  };
  // An already-set quantity the chosen depot cannot take. Caught rather than silently rewritten — the
  // number came from the engineer, so the form says it is wrong instead of changing it behind them.
  const overDepot = picked.find((h) => {
    const atDepot = unitsAtDepot(h, effectiveWarehouseId);
    return atDepot !== null && (quantities[vanStockItemKey(h)] ?? 0) > atDepot;
  });

  const advisory = openLineAdvisory(
    picked
      .filter((h) => openKeys.has(vanStockItemKey(h)))
      .map((h) => ({ name: h.name, code: openKeys.get(vanStockItemKey(h)) })),
    "return",
  );

  const submit = async () => {
    // Built through toLinePayload so exactly one id travels with the discriminator — the server
    // refuses a line carrying both outright, and the wrong one would credit company stock for a hire.
    const lines = picked.map((h) =>
      toLinePayload({ ...h, qty: quantities[vanStockItemKey(h)]! }),
    );
    if (lines.length === 0) {
      setError("Pick at least one item to return.");
      return;
    }
    // `unknown` means a hire whose depot we could not resolve — the field says why, and there is no
    // safe destination to submit, so this stops it here rather than at the counter.
    if (!effectiveWarehouseId) {
      setError("Pick the warehouse you'll return the stock to.");
      return;
    }
    // The cap on the stepper stops this being set; this stops a quantity that was already set before
    // the depot was chosen from riding to a server that can only refuse it.
    if (overDepot) {
      const atDepot = unitsAtDepot(overDepot, effectiveWarehouseId) ?? 0;
      setError(
        `Only ${atDepot} of ${overDepot.name} was collected from that depot. Lower the quantity, and return the rest on a separate request to the other depot.`,
      );
      return;
    }
    if (!reason.trim()) {
      setError("Say why you're returning this stock.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createVanStockRequest({
        type: "return",
        reason: reason.trim(),
        warehouseId: effectiveWarehouseId,
        lines,
      });
      toast.success("Return raised — drive in and the warehouse will scan it in.");
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not raise the return.");
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

  const returningHire = picked.some((h) => h.source === "rental");

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={() => {
        void refreshHoldings();
        void reloadWarehouses();
        void reloadOpenLines();
      }}
    >
      <Text style={s.hint}>No approval needed — the warehouse scans it in when you arrive.</Text>

      <SectionTitle>Pick from your stock</SectionTitle>
      <Text style={s.hint}>
        Only your free field stock — anything issued for a job goes back when you complete that job,
        not here. Hired kit follows the same rule: a hire out on a job goes back through that job.
      </Text>
      {advisory ? (
        <Card style={s.warnCard}>
          <Text style={s.warnText}>{advisory.text}</Text>
          {advisory.detail ? <Text style={s.warnDetail}>{advisory.detail}</Text> : null}
        </Card>
      ) : null}
      {holdingsError ? (
        <ErrorText message="Couldn't load your on-hand stock. Refresh and try again." />
      ) : (holdings ?? []).length === 0 ? (
        <EmptyState title="You're not holding any returnable stock right now" />
      ) : (
        (holdings ?? []).map((h) => {
          const key = vanStockItemKey(h);
          const isRental = h.source === "rental";
          const staged = (quantities[key] ?? 0) > 0;
          const blockedWhy = blockedRows.get(key);
          const max = capFor(h);
          return (
            // Tapping an unstaged row brings back the WHOLE holding — the web picker's behaviour,
            // and the common case: an engineer emptying the van is not counting units up from zero
            // one tap at a time. The stepper beside it is for the rarer partial return.
            //
            // A blocked row takes no tap at all. `canAddRental` is still called as the backstop, but
            // a row that cannot join this return should not invite the tap in the first place.
            <Card
              key={key}
              onPress={
                staged || blockedWhy
                  ? undefined
                  : () => {
                      const verdict = canAddRental(picked, h);
                      if (!verdict.ok) {
                        setError(verdict.reason);
                        return;
                      }
                      setError(null);
                      setQuantities((prev) => ({ ...prev, [key]: max }));
                    }
              }
              style={staged ? s.stagedCard : blockedWhy ? s.blockedCard : undefined}
            >
              <View style={s.lineRow}>
                <View style={s.lineMain}>
                  <View style={s.nameRow}>
                    <Text style={s.lineName} numberOfLines={2}>
                      {h.name}
                    </Text>
                    {isRental ? <RentalBadge /> : null}
                  </View>
                  {/* Free-to-return qty = van holding MINUS stock committed to active jobs (that goes
                      back via the job's Close & Reconcile, not here). */}
                  <Text style={s.meta}>
                    {h.code} · {h.quantityOnHand} free to return
                    {isRental && h.poCodes.length > 0 ? ` · ${h.poCodes.join(", ")}` : ""}
                  </Text>
                  {/* THE DEADLINE LEADS on a hire — it is the only thing here that keeps costing
                      money while the kit sits in the van. UTC-pinned: a hire deadline is a calendar
                      day, and formatDate would show the day before on any device behind UTC.
                      `overdue` is resolved server-side against the company timezone. */}
                  {isRental && h.hireEndDate ? (
                    <Text style={[s.meta, h.overdue && s.overdueText]}>
                      {h.overdue
                        ? `Was due back ${formatHireDate(h.hireEndDate)} — overdue`
                        : `Return by ${formatHireDate(h.hireEndDate)}`}
                    </Text>
                  ) : null}
                  {/* WHERE IT CAME FROM. A hire goes back to the depot that took delivery — the
                      provider collects it from there — so this is not optional context the way it
                      would be for company stock, which has no such origin. */}
                  {isRental && h.depots.length > 0 ? (
                    <Text style={blockedWhy === "other-depot" ? s.blockedText : s.meta}>
                      Collected from {h.depots.map((d) => d.warehouseName).join(" · ")}
                      {blockedWhy === "other-depot" ? " · needs its own return" : ""}
                    </Text>
                  ) : null}
                  {blockedWhy === "unknown-depot" ? (
                    // No depot line to hang it on, so the refusal gets its own. Never guess a depot:
                    // a return posted to the wrong counter is what the server refuses.
                    <Text style={s.blockedText}>Depot unknown — refresh and try again</Text>
                  ) : null}
                </View>
                <Stepper
                  value={quantities[key] ?? 0}
                  min={0}
                  // Capped at what the CHOSEN depot holds, not the row's roll-up across depots.
                  max={max}
                  disabled={blockedWhy !== undefined}
                  onChange={(next) => setQuantities((prev) => ({ ...prev, [key]: next }))}
                />
              </View>
            </Card>
          );
        })
      )}

      {/* Hidden entirely when there is nothing to pick from — the hint below points "above" at a
          list that is not there, and the section is noise on a screen with no holdings. */}
      {(holdings ?? []).length > 0 ? (
        <>
          <SectionTitle>{picked.length ? `Selected items (${picked.length})` : "Selected items"}</SectionTitle>
          {picked.length === 0 ? (
            <Text style={s.hint}>Tap an item above to bring the whole holding back, or step up a part of it.</Text>
          ) : (
            <Card>
              {picked.map((h) => {
                const key = vanStockItemKey(h);
                return (
                  <View key={key} style={s.pickedRow}>
                    <Text style={s.pickedName} numberOfLines={1}>
                      {h.name}
                    </Text>
                    <Text style={s.pickedQty}>×{quantities[key]}</Text>
                  </View>
                );
              })}
            </Card>
          )}
        </>
      ) : null}

      {warehousesError ? (
        <ErrorText message="Couldn't load warehouses. Refresh and try again." />
      ) : null}
      <Select
        label="Return to warehouse"
        required
        // Narrowed to the hire's depot(s), so an invalid destination is not reachable by tapping.
        // FIXED rather than disabled when hired kit decides it: the field still holds the answer and
        // must stay readable and reachable, so the options collapse to the one valid depot instead.
        options={warehouseOptions}
        value={effectiveWarehouseId || null}
        onChange={setWarehouseId}
        placeholder={depot.kind === "unknown" ? "No valid depot" : "Pick a warehouse…"}
      />
      {/* One line, in the hint register the rest of the form already uses. It says why the field is
          not a free choice — the one thing the engineer could not see before, and which they used to
          discover as a refusal at the counter after driving there. */}
      {depot.kind === "fixed" ? (
        <Text style={s.hint}>
          Set by the hired kit in this return — it goes back to the depot it was collected from.
        </Text>
      ) : null}
      {depot.kind === "restricted" ? (
        <Text style={s.hint}>
          Only depots the hired kit in this return can go back to are listed. Quantities are capped at
          what was collected from the depot you pick — anything left goes back on its own return.
        </Text>
      ) : null}
      {/* Never guess a destination. Without a resolvable depot there is no way to know which counter
          can take the hire, so say so and let them recover rather than build a request the warehouse
          must refuse. */}
      {depot.kind === "unknown" ? (
        <ErrorText message="We couldn't work out which depot this hired kit goes back to. Refresh and try again, or ask the office to check the order." />
      ) : null}
      {depot.kind === "free" && returningHire ? (
        <Text style={s.hint}>
          Hired kit goes back to the depot it was collected from — shown on each hired item above.
        </Text>
      ) : null}

      <Input
        label="Reason"
        required
        value={reason}
        onChangeText={setReason}
        multiline
        maxLength={2000}
        placeholder="e.g. Over-stocked after last month's jobs — returning the excess."
      />
      <SectionTitle>Summary</SectionTitle>
      <Card>
        {/* Empty string, not the id — InfoRow renders it as the em dash the web summary shows until
            a destination is picked. */}
        <InfoRow label="Return to" value={returnWarehouseLabel} />
        <InfoRow label="Items" value={picked.length} />
        <InfoRow label="Total quantity" value={totalQty} />
      </Card>
      <ErrorText message={error} />
      <Button title="Raise return" onPress={() => void submit()} loading={busy} />
    </Screen>
  );
}

const s = StyleSheet.create({
  hint: { fontSize: 13, color: colors.muted },
  lineName: { fontSize: 14, fontWeight: "700", color: colors.text, flexShrink: 1 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  meta: { fontSize: 12, color: colors.muted },
  overdueText: { color: colors.danger, fontWeight: "700" },
  lineRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  lineMain: { flex: 1, gap: 2 },
  stagedCard: { borderColor: colors.accent },
  // Amber border rather than the staged row's tint: the reason is TEXT on this row, and text is the
  // thing least worth dimming. The surface stays as it was, so a refused row still reads as
  // recessive next to the ones that can be tapped.
  blockedCard: { borderColor: colors.warn },
  blockedText: { fontSize: 12, fontWeight: "700", color: colors.warn },
  pickedRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  pickedName: { fontSize: 13, color: colors.text, flex: 1 },
  pickedQty: { fontSize: 13, fontWeight: "700", color: colors.text },
  warnCard: { borderColor: colors.warn, backgroundColor: colors.warnSoft },
  warnText: { fontSize: 13, color: colors.warn },
  warnDetail: { fontSize: 12, color: colors.warn, opacity: 0.85 },
});
