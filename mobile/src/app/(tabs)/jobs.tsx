import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { getOwnJobs } from "@/services/engineer.service";
import { useLoad } from "@/lib/useLoad";
import { useDebounced } from "@/lib/useDebounced";
import { useSocketRefresh } from "@/lib/useSocketRefresh";
import {
  Badge,
  Card,
  EmptyState,
  ErrorText,
  FilterGroup,
  ListFade,
  ListSkeleton,
  Pager,
  Screen,
  SearchFilterBar,
} from "@/components/ui";
import { colors } from "@/lib/theme";
import { formatDate } from "@/lib/format";

const STATUS_FILTERS = [
  { key: "", label: "All statuses" },
  { key: "assigned", label: "Assigned" },
  { key: "accepted", label: "Accepted" },
  { key: "in_progress", label: "In progress" },
  // "Overdue" is not a stored status — the backend derives it (active job, completion date passed).
  { key: "overdue", label: "Overdue" },
  { key: "completed", label: "Completed" },
  { key: "rejected", label: "Rejected" },
  { key: "cancelled", label: "Cancelled" },
];

const SORT_OPTIONS = [
  { key: "", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
];

// Exactly the web's useJobSocket event set — job:updated covers edits, cancel,
// start and complete; job:deleted covers deletes AND reassignment away from you.
const JOB_EVENTS = ["job:new", "job:accepted", "job:rejected", "job:updated", "job:deleted"];

export default function JobsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ status?: string; t?: string }>();
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const query = useDebounced(q);

  // Dashboard deep-links: /(tabs)/jobs?status=assigned|overdue|in_progress seeds
  // the filter; an empty status ("All jobs" link) resets it. The `t` nonce makes
  // repeat taps of the same card re-seed. (Async tick keeps the update out of the
  // effect body for the lint.)
  useEffect(() => {
    const seed = params.status;
    if (typeof seed !== "string") return;
    const timer = setTimeout(() => {
      setStatus(seed);
      setPage(1);
    }, 0);
    return () => clearTimeout(timer);
  }, [params.status, params.t]);

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
  // What the trigger's badge counts. Sort is included even though it narrows nothing: once it is
  // folded out of sight, a list ordered oldest-first with no visible reason is the same confusion the
  // badge exists to prevent. Search is NOT counted — its box is right there with the text still in it.
  const activeFilters = (status ? 1 : 0) + (sort ? 1 : 0);

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <SearchFilterBar
        placeholder="Search job no., name or customer…"
        value={q}
        onChangeText={(v) => {
          setQ(v);
          setPage(1);
        }}
        activeCount={activeFilters}
        onClear={() => {
          setStatus("");
          setSort("");
          setPage(1);
        }}
      >
        <FilterGroup
          label="Status"
          options={STATUS_FILTERS}
          value={status}
          onChange={(key) => {
            setStatus(key);
            setPage(1);
          }}
        />
        <FilterGroup
          label="Sort"
          options={SORT_OPTIONS}
          value={sort}
          onChange={(key) => {
            setSort(key);
            setPage(1);
          }}
        />
      </SearchFilterBar>
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
                {job.completionDate ? (
                  <Text style={[s.due, job.overdue && s.dueOverdue]}>Due {formatDate(job.completionDate)}</Text>
                ) : null}
                {/* `overdue` and `daysLate` are both server-derived against the company timezone —
                    see the note on the Job type. Rendered, never recomputed from completionDate. */}
                {job.overdue && job.daysLate != null ? (
                  <Text style={s.latePill}>{job.daysLate}d late</Text>
                ) : null}
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
  dueOverdue: { color: colors.danger, fontWeight: "700" },
  // Mirrors the web's "Nd late" pill: the count is what turns "this is late" into "this is 9 days
  // late", which is the difference between a row you scroll past and one you act on.
  latePill: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.danger,
    backgroundColor: colors.dangerSoft,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
    overflow: "hidden",
  },
  kitBadge: { fontSize: 12, fontWeight: "600", color: colors.warn },
});
