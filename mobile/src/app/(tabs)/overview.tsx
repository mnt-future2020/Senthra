import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { getOwnOverview } from "@/services/engineer.service";
import { useLoad } from "@/lib/useLoad";
import { principalName, useAuth } from "@/lib/auth";
import { Card, EmptyState, ErrorText, ListSkeleton, Screen, SectionTitle, Skeleton } from "@/components/ui";
import { colors } from "@/lib/theme";
import { signed, timeAgo } from "@/lib/format";

export default function OverviewScreen() {
  const router = useRouter();
  const { principal } = useAuth();
  const { data, loading, refreshing, error, refresh } = useLoad(getOwnOverview);

  if (loading)
    return (
      <Screen>
        <Skeleton width="55%" height={22} />
        <View style={s.statRow}>
          <Card style={s.stat}>
            <Skeleton width="40%" height={24} />
            <Skeleton width="70%" height={11} />
          </Card>
          <Card style={s.stat}>
            <Skeleton width="40%" height={24} />
            <Skeleton width="70%" height={11} />
          </Card>
        </View>
        <ListSkeleton count={4} />
      </Screen>
    );

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <Text style={s.greeting}>Hello, {principalName(principal).split(" ")[0]}</Text>
      <ErrorText message={error} />

      <View style={s.statRow}>
        <Card style={s.stat}>
          <Text style={s.statValue}>{data?.stock.lines ?? 0}</Text>
          <Text style={s.statLabel}>Stock lines on van</Text>
        </Card>
        <Card style={s.stat}>
          <Text style={s.statValue}>{data?.stock.totalQuantity ?? 0}</Text>
          <Text style={s.statLabel}>Total units held</Text>
        </Card>
      </View>

      <SectionTitle>Quick actions</SectionTitle>
      <View style={s.actionsGrid}>
        <Card style={s.action} onPress={() => router.push("/jobs")}>
          <Ionicons name="briefcase" size={22} color={colors.accent} />
          <Text style={s.actionText}>My Jobs</Text>
        </Card>
        <Card style={s.action} onPress={() => router.push("/van-stock/new")}>
          <Ionicons name="add-circle" size={22} color={colors.accent} />
          <Text style={s.actionText}>Request Stock</Text>
        </Card>
        <Card style={s.action} onPress={() => router.push("/van-stock/return")}>
          <Ionicons name="return-down-back" size={22} color={colors.accent} />
          <Text style={s.actionText}>Return Stock</Text>
        </Card>
        <Card style={s.action} onPress={() => router.push("/transfers/new")}>
          <Ionicons name="swap-horizontal" size={22} color={colors.accent} />
          <Text style={s.actionText}>Van Transfer</Text>
        </Card>
      </View>

      <SectionTitle>Recent activity</SectionTitle>
      {data && data.recentActivity.length === 0 ? (
        <EmptyState title="No recent activity" subtitle="Stock movements on your van will appear here." />
      ) : (
        (data?.recentActivity ?? []).map((a) => (
          <Card key={a.id}>
            <View style={s.activityRow}>
              <View style={s.activityMain}>
                <Text style={s.activityTitle} numberOfLines={1}>
                  {a.itemName}
                </Text>
                <Text style={s.activityMeta}>
                  {a.label}
                  {a.sourceCode ? ` · ${a.sourceCode}` : ""} · {timeAgo(a.createdAt)}
                </Text>
              </View>
              <Text
                style={[
                  s.activityQty,
                  { color: a.quantityDelta >= 0 ? colors.success : colors.danger },
                ]}
              >
                {signed(a.quantityDelta)}
              </Text>
            </View>
          </Card>
        ))
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  greeting: { fontSize: 22, fontWeight: "800", color: colors.text, marginBottom: 2 },
  statRow: { flexDirection: "row", gap: 12 },
  stat: { flex: 1, alignItems: "flex-start", gap: 2 },
  statValue: { fontSize: 26, fontWeight: "800", color: colors.text },
  statLabel: { fontSize: 12, color: colors.muted },
  actionsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  action: { flexBasis: "47%", flexGrow: 1, alignItems: "flex-start", gap: 6, paddingVertical: 16 },
  actionText: { fontSize: 14, fontWeight: "600", color: colors.text },
  activityRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  activityMain: { flex: 1, gap: 2 },
  activityTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  activityMeta: { fontSize: 12, color: colors.muted },
  activityQty: { fontSize: 16, fontWeight: "800" },
});
