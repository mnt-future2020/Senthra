import React from "react";
import { StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { getPublishedPolicy, type PolicyBlock } from "@/services/policy.service";
import { useLoad } from "@/lib/useLoad";
import { Card, EmptyState, ErrorText, Screen, Skeleton } from "@/components/ui";
import { colors } from "@/lib/theme";
import { formatDate } from "@/lib/format";

/**
 * The public privacy notice — the mobile twin of the web's `/privacy` page.
 *
 * PUBLIC by design, and registered outside the root stack's `Stack.Protected` guard: a data subject
 * must be able to read how their personal data is handled without holding an account, which is why
 * the sign-in screen links here. It is also the reason this screen never calls anything but the one
 * unauthenticated endpoint — reaching it must not depend on a session.
 *
 * It renders the PUBLISHED policy and nothing else. The content is authored in the web dashboard
 * (Settings → Legal) and published by someone holding `policy.publish`; no policy text is shipped in
 * this file, and there is no fallback that could put unapproved wording in front of a reader.
 *
 * ── WHY THIS EXISTS ON MOBILE EVEN THOUGH THE WEB PAGE IS UNLISTED ─────────────────────────────
 * The web page is deliberately undiscoverable until the client approves the published version (see
 * the two manual switches documented in `frontend/src/app/privacy/page.tsx`). That choice does not
 * carry over here. An app that handles personal data cannot be submitted to either store without a
 * reachable privacy notice, so on mobile this is linked from sign-in and from Account from the
 * start. Nothing is disclosed by linking it: if no policy is published the screen says so, exactly
 * as the web page does.
 */
export default function PrivacyScreen() {
  const { data, loading, refreshing, error, refresh } = useLoad(getPublishedPolicy);
  const policy = data?.policy ?? null;

  if (loading)
    return (
      <Screen>
        <View style={s.skeleton}>
          <Skeleton width="40%" height={12} />
          <Skeleton width="70%" height={18} />
          <Skeleton width="100%" height={12} />
          <Skeleton width="95%" height={12} />
          <Skeleton width="88%" height={12} />
          <Skeleton width="55%" height={18} />
          <Skeleton width="100%" height={12} />
          <Skeleton width="92%" height={12} />
        </View>
      </Screen>
    );

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <Text style={s.eyebrow}>Data protection</Text>
      <ErrorText message={error} />

      {policy ? (
        <>
          <Text style={s.meta}>
            Version {policy.version} · Published {formatDate(policy.publishedAt)}
          </Text>
          <View style={s.blocks}>
            {policy.blocks.map((block, i) => (
              <Block key={i} block={block} />
            ))}
          </View>
        </>
      ) : error ? (
        // The request failed. Distinct from "nothing published" on purpose — this one is
        // recoverable, and saying so is the difference between a reader who pulls to refresh and
        // one who concludes the company has no privacy notice.
        <EmptyState
          icon={<Ionicons name="cloud-offline-outline" size={28} color={colors.faint} />}
          title="Couldn't load the privacy notice"
          subtitle="Pull down to try again once you're back on a connection."
        />
      ) : (
        <Card>
          <Text style={s.unavailableTitle}>Not available yet</Text>
          <Text style={s.unavailableBody}>
            A privacy notice has not been published for this service yet. If you need information
            about how your personal data is handled, please contact your administrator.
          </Text>
        </Card>
      )}
    </Screen>
  );
}

/**
 * One parsed block.
 *
 * Every value reaches the screen as a React Native `<Text>` child. RN has no HTML parser and no
 * `dangerouslySetInnerHTML` equivalent, so author-supplied content is structurally incapable of
 * becoming markup here — a body containing `<script>` renders those characters. The web renderer
 * relies on React escaping for the same guarantee; on this side it is a property of the platform.
 *
 * Line breaks inside a paragraph are preserved by `<Text>` as-is — addresses and stacked clauses
 * depend on them — which is what the web's `whitespace-pre-wrap` buys.
 */
function Block({ block }: { block: PolicyBlock }) {
  switch (block.type) {
    case "heading":
      return <Text style={s.heading}>{block.text}</Text>;
    case "list":
      return (
        <View style={s.list}>
          {block.items.map((item, i) => (
            <View key={i} style={s.listItem}>
              <Text style={s.bullet}>{"•"}</Text>
              <Text style={s.listText}>{item}</Text>
            </View>
          ))}
        </View>
      );
    case "paragraph":
    default:
      return <Text style={s.paragraph}>{block.text}</Text>;
  }
}

const s = StyleSheet.create({
  skeleton: { gap: 12, paddingTop: 4 },
  eyebrow: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: colors.accent,
  },
  meta: { fontSize: 12, color: colors.faint, marginTop: -6 },
  blocks: { gap: 14, paddingTop: 4 },
  heading: { fontSize: 16, fontWeight: "800", color: colors.text, paddingTop: 6 },
  paragraph: { fontSize: 14, lineHeight: 21, color: colors.muted },
  list: { gap: 6 },
  listItem: { flexDirection: "row", gap: 8, paddingLeft: 2 },
  bullet: { fontSize: 14, lineHeight: 21, color: colors.faint },
  listText: { flex: 1, fontSize: 14, lineHeight: 21, color: colors.muted },
  unavailableTitle: { fontSize: 14, fontWeight: "700", color: colors.text },
  unavailableBody: { fontSize: 13, lineHeight: 20, color: colors.muted },
});
