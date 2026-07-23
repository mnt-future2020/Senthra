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

  const { data: job, loading } = useLoad(useCallback(() => getOwnJob(id), [id]));

  const stockLines = useMemo(() => (job?.kitLines ?? []).filter((l) => l.lineType !== "misc"), [job]);

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
      setError(err instanceof Error ? err.message : "Could not complete the job.");
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
    <Screen>
      <Card>
        <Text style={s.jobNumber}>{job.jobNumber}</Text>
        <Text style={s.jobName}>{job.name}</Text>
      </Card>

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
  lineRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  lineMain: { flex: 1, gap: 2 },
  lineName: { fontSize: 14, fontWeight: "700", color: colors.text },
  lineMeta: { fontSize: 12, color: colors.muted },
});
