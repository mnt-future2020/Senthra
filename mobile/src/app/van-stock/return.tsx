import React, { useCallback, useState } from "react";
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
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  Input,
  ListSkeleton,
  Screen,
  SectionTitle,
  Select,
  Stepper,
} from "@/components/ui";
import { colors } from "@/lib/theme";

// Return composer — hand company IRM stock from your van back to a warehouse.
// No approval step: the warehouse scanning the stock in IS the acceptance.
export default function ReturnVanStockScreen() {
  const router = useRouter();
  const toast = useToast();
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: holdings, loading } = useLoad(useCallback(() => myHoldings(), []));
  const { data: warehouses } = useLoad(useCallback(() => listWarehousesLite(), []));
  // Advisory duplicate guard — items already on my OPEN return requests.
  const { data: openLines } = useLoad(useCallback(() => myOpenLineItems("return"), []));

  const duplicates = (holdings ?? []).filter(
    (h) => (quantities[h.irmItemId] ?? 0) > 0 && (openLines ?? []).some((o) => o.irmItemId === h.irmItemId),
  );

  const submit = async () => {
    const lines = (holdings ?? [])
      .filter((h) => (quantities[h.irmItemId] ?? 0) > 0)
      .map((h) => ({ irmItemId: h.irmItemId, itemName: h.name, qty: quantities[h.irmItemId]! }));
    if (lines.length === 0) {
      setError("Pick at least one item to return.");
      return;
    }
    if (!warehouseId) {
      setError("Pick the warehouse you'll return the stock to.");
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
        warehouseId,
        lines,
      });
      toast.success("Return raised — drive in and the warehouse will scan it in.");
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the return.");
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

  return (
    <Screen>
      <Text style={s.hint}>
        Pick the quantities you&rsquo;re bringing back. The warehouse scans them in when you arrive.
      </Text>

      <SectionTitle>Your van holdings</SectionTitle>
      {duplicates.length > 0 ? (
        <Card style={s.warnCard}>
          <Text style={s.warnText}>
            Heads up — you already have an open request for:{" "}
            {duplicates.map((d) => `${d.name} (${d.code})`).join(", ")}. You can still send this one.
          </Text>
        </Card>
      ) : null}
      {(holdings ?? []).length === 0 ? (
        <EmptyState title="You're not holding any returnable stock right now" />
      ) : (
        (holdings ?? []).map((h) => (
          <Card key={h.irmItemId}>
            <View style={s.lineRow}>
              <View style={s.lineMain}>
                <Text style={s.lineName} numberOfLines={2}>
                  {h.name}
                </Text>
                {/* Free-to-return qty = van holding MINUS stock committed to active jobs (that goes
                    back via the job's Close & Reconcile, not here). */}
                <Text style={s.meta}>
                  {h.code} · {h.quantityOnHand} free to return
                </Text>
              </View>
              <Stepper
                value={quantities[h.irmItemId] ?? 0}
                min={0}
                max={h.quantityOnHand}
                onChange={(next) => setQuantities((prev) => ({ ...prev, [h.irmItemId]: next }))}
              />
            </View>
          </Card>
        ))
      )}

      <Select
        label="Return to warehouse"
        required
        options={(warehouses ?? []).map((w) => ({ key: w.id, label: w.code ? `${w.name} (${w.code})` : w.name }))}
        value={warehouseId}
        onChange={setWarehouseId}
        placeholder="Pick a warehouse…"
      />

      <Input
        label="Reason"
        required
        value={reason}
        onChangeText={setReason}
        multiline
        maxLength={2000}
        placeholder="e.g. Over-stocked after last month's jobs — returning the excess."
      />
      <ErrorText message={error} />
      <Button title="Submit Return" onPress={() => void submit()} loading={busy} />
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
});
