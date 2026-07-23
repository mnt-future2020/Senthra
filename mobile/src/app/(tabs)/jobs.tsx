import React, { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { getOwnJobs } from "@/services/engineer.service";
import { useLoad } from "@/lib/useLoad";
import { useDebounced } from "@/lib/useDebounced";
import { useSocketRefresh } from "@/lib/useSocketRefresh";
import {
  Badge,
  Card,
  EmptyState,
  ErrorText,
  FilterRow,
  Input,
  ListFade,
  ListSkeleton,
  Pager,
  Screen,
  Select,
} from "@/components/ui";
import { colors } from "@/lib/theme";
import { formatDate } from "@/lib/format";

const STATUS_FILTERS = [
  { key: "", label: "All statuses" },
  { key: "assigned", label: "Assigned" },
  { key: "accepted", label: "Accepted" },
  { key: "in_progress", label: "In progress" },
  { key: "completed", label: "Completed" },
  { key: "rejected", label: "Rejected" },
  { key: "cancelled", label: "Cancelled" },
];

const SORT_OPTIONS = [
  { key: "", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
];

// The events the web jobs list live-refreshes on (useJobSocket) plus job:updated,
// which the backend sends to the assigned engineer on goods issue/return.
const JOB_EVENTS = ["job:new", "job:accepted", "job:rejected", "job:deleted", "job:updated", "job:cancelled"];

export default function JobsScreen() {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const query = useDebounced(q);

  const { data, loading, fetching, refreshing, error, reload, refresh } = useLoad(
    useCallback(async () => {
      const result = await getOwnJobs({
        status: status || undefined,
        q: query || undefined,
        sort: sort || undefined,
        page,
        pageSize: 20,
      });
      // If a narrower filter shrinks the result set below the current page, snap back.
      if (result.totalPages > 0 && page > result.totalPages) setPage(result.totalPages);
      return result;
    }, [status, query, sort, page]),
  );

  useSocketRefresh(JOB_EVENTS, () => void reload());

  if (loading)
    return (
      <Screen>
        <ListSkeleton />
      </Screen>
    );

  const filtered = Boolean(status || query);

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <Input
        placeholder="Search job no., name or customer…"
        value={q}
        onChangeText={(v) => {
          setQ(v);
          setPage(1);
        }}
        autoCapitalize="none"
        returnKeyType="search"
      />
      <FilterRow>
        <Select
          options={STATUS_FILTERS}
          value={status}
          onChange={(key) => {
            setStatus(key);
            setPage(1);
          }}
        />
        <Select
          options={SORT_OPTIONS}
          value={sort}
          onChange={(key) => {
            setSort(key);
            setPage(1);
          }}
        />
      </FilterRow>
      <ErrorText message={error} />

      <ListFade dimmed={fetching}>
        {data && data.jobs.length === 0 ? (
          filtered ? (
            <EmptyState title="No matching jobs" subtitle="Try a different search or status filter." />
          ) : (
            <EmptyState title="No jobs assigned" subtitle="Jobs assigned to you will appear here." />
          )
        ) : (
          (data?.jobs ?? []).map((job) => (
            <Card key={job.id} onPress={() => router.push({ pathname: "/jobs/[id]", params: { id: job.id } })}>
              <View style={s.rowTop}>
                <Text style={s.jobNumber}>{job.jobNumber}</Text>
                <Badge status={job.status} />
              </View>
              <Text style={s.jobName} numberOfLines={2}>
                {job.name}
              </Text>
              <Text style={s.meta} numberOfLines={1}>
                {job.customerName ?? "—"}
                {job.siteName ? ` · ${job.siteName}` : ""}
                {job.city ? ` · ${job.city}` : ""}
              </Text>
              <View style={s.rowBottom}>
                <Badge status={job.priority} />
                {job.completionDate ? <Text style={s.due}>Due {formatDate(job.completionDate)}</Text> : null}
                {job.pendingKitRequestCount > 0 ? (
                  <Text style={s.kitBadge}>{job.pendingKitRequestCount} kit pending</Text>
                ) : null}
              </View>
            </Card>
          ))
        )}
        {data ? (
          <Pager page={data.page} totalPages={data.totalPages} onPage={setPage} total={data.total} label="jobs" />
        ) : null}
      </ListFade>
    </Screen>
  );
}

const s = StyleSheet.create({
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  jobNumber: { fontSize: 13, fontWeight: "700", color: colors.accent },
  jobName: { fontSize: 15, fontWeight: "700", color: colors.text },
  meta: { fontSize: 13, color: colors.muted },
  rowBottom: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  due: { fontSize: 12, color: colors.muted },
  kitBadge: { fontSize: 12, fontWeight: "600", color: colors.warn },
});
