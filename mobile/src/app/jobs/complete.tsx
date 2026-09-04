import React, { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { completeOwnJob, getOwnJob } from "@/services/engineer.service";
import { useLoad } from "@/lib/useLoad";
import { useToast } from "@/lib/toast";
import { Button, Card, DetailSkeleton, EmptyState, ErrorText, Input, Screen, SectionTitle, Stepper } from "@/components/ui";
import { colors } from "@/lib/theme";
import type { UsedLinePayload } from "@/types";

// Complete an in-progress job: declare quantities used per kit line (draining the
// van by those amounts) plus an optional work summary. Mirrors the web's inline
// "Complete this job" form: every stock-tracked line is listed (misc excluded),
// quantities default to 0, and a line with nothing held is shown but locked.
export default function CompleteJobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [used, setUsed] = useState<Record<string, number>>({});
  const [workSummary, setWorkSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: job, loading, refreshing, refresh } = useLoad(useCallback(() => getOwnJob(id), [id]));

  // ALLOWLIST, deliberately — not `!== "misc"`.
  //
  // Only IRM and customer stock can be declared "used" on site. Hired kit never can: it is equipment
  // we do not own and every unit goes back to the provider, so the API's usedLines source enum admits
  // only these two. With the old exclude-misc filter a rental line landed here, was labelled
  // "Customer stock" by the ternary below and posted `source: "customer"` with no entry id — a payload
  // the server refuses, leaving the engineer unable to complete the job at all.
  const stockLines = useMemo(
    () => (job?.kitLines ?? []).filter((l) => l.lineType === "irm" || l.lineType === "customer_stock"),
    [job],
  );

  // Hired kit whose deadline has ALREADY passed and which is still out.
  //
  // Only the overdue ones. A hire that is simply still with the engineer is normal, and its return
  // date is already on its kit row on the job screen — repeating the whole list here would restate
  // what they just scrolled past. What survives is the case the date alone cannot cover: the deadline
  // has passed and the kit has not gone back. That is not a reminder, it is a hire billing us for
  // days nobody agreed to, and it is worth one line on the way out. Never blocks the button.
  const hiresOverdue = useMemo(
    () => (job?.kitLines ?? []).filter((l) => l.lineType === "rental" && l.remaining > 0 && l.hireOverdue),
    [job],
  );
  const hiresOverdueUnits = hiresOverdue.reduce((n, l) => n + l.remaining, 0);

  const qtyFor = (lineId: string) => used[lineId] ?? 0;

  const submit = async () => {
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      const usedLines: UsedLinePayload[] = stockLines
        .map((line) => ({
          source: (line.lineType === "irm" ? "irm" : "customer") as UsedLinePayload["source"],
          irmItemId: line.irmItemId ?? undefined,
          customerStockEntryId: line.customerStockEntryId ?? undefined,
          jobKitLineId: line.id,
          qty: Math.min(qtyFor(line.id), line.remaining),
        }))
        .filter((l) => l.qty > 0);
      await completeOwnJob(job.id, { workSummary: workSummary.trim() || undefined, usedLines });
      toast.success("Job marked as complete. Well done!");
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not complete this job.");
    } finally {
      setBusy(false);
    }
  };

  if (loading)
    return (
      <Screen>
        <DetailSkeleton />
      </Screen>
    );
  if (!job) {
    return (
      <Screen>
        <ErrorText message="Job not found." />
      </Screen>
    );
  }

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <Card>
        <Text style={s.jobNumber}>{job.jobNumber}</Text>
        <Text style={s.jobName}>{job.name}</Text>
      </Card>

      {hiresOverdue.length > 0 ? (
        // Amber, not red: the job can still be completed and nothing here is blocked. It is money
        // leaking, which earns a line on the way out — not a wall.
        <View style={s.hireWarn}>
          <Text style={s.hireWarnText}>
            {`${hiresOverdue.map((l) => `${l.remaining} × ${l.itemName}`).join(", ")} `}
            {`${hiresOverdueUnits === 1 ? "is" : "are"} past the hire return date. `}
            {`Get ${hiresOverdueUnits === 1 ? "it" : "them"} back to the warehouse — or ask the warehouse to extend the hire if you still need ${hiresOverdueUnits === 1 ? "it" : "them"}.`}
          </Text>
        </View>
      ) : null}

      <SectionTitle>Stock used</SectionTitle>
      <Text style={s.hint}>
        Declare how many of each item you used on site. Leave at 0 if unused — the rest is treated
        as still held (return it to the warehouse). You can&rsquo;t declare more than you&rsquo;re holding.
      </Text>
      {stockLines.length === 0 ? (
        <EmptyState title="No stock-tracked kit on this job" subtitle="You can complete without declaring usage." />
      ) : (
        stockLines.map((line) => (
          <Card key={line.id}>
            <View style={s.lineRow}>
              <View style={s.lineMain}>
                <Text style={s.lineName} numberOfLines={2}>
                  {line.itemName}
                </Text>
                <Text style={s.lineMeta}>
                  {line.lineType === "irm" ? "IRM" : "Customer stock"} · {line.warehouseName ?? "—"}
                </Text>
                <Text style={s.lineMeta}>
                  {line.remaining === 0 ? "Nothing issued to you for this item" : `Held: ${line.remaining}`}
                </Text>
              </View>
              <Stepper
                value={qtyFor(line.id)}
                min={0}
                max={line.remaining}
                onChange={(next) => setUsed((prev) => ({ ...prev, [line.id]: next }))}
              />
            </View>
          </Card>
        ))
      )}

      <Input
        label="Work summary (optional)"
        value={workSummary}
        onChangeText={setWorkSummary}
        multiline
        maxLength={4000}
        placeholder="Describe the work completed on site…"
      />
      <ErrorText message={error} />
      <Button title="Confirm complete" onPress={() => void submit()} loading={busy} />
    </Screen>
  );
}

const s = StyleSheet.create({
  jobNumber: { fontSize: 13, fontWeight: "700", color: colors.accent },
  jobName: { fontSize: 16, fontWeight: "800", color: colors.text },
  hint: { fontSize: 13, color: colors.muted },
  hireWarn: {
    backgroundColor: colors.warnSoft,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  hireWarnText: { fontSize: 12, fontWeight: "600", color: colors.warn, lineHeight: 17 },
  lineRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  lineMain: { flex: 1, gap: 2 },
  lineName: { fontSize: 14, fontWeight: "700", color: colors.text },
  lineMeta: { fontSize: 12, color: colors.muted },
});
