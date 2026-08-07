import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { StyleProp, TextInputProps, ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
// This Expo Router build vendors react-navigation — these are the supported subpaths.
import { HeaderHeightContext } from "expo-router/react-navigation";
import { BottomTabBarHeightContext } from "expo-router/js-tabs";
import { colors, statusTone, toneColors } from "../lib/theme";
import { titleCase } from "../lib/format";

// ── Layout ────────────────────────────────────────────────────────────────────

/**
 * Frosted-glass backdrop for the tab navigator's header and tab bar: content
 * scrolling underneath shows through blurred (iOS) or translucent (Android/web,
 * where backdrop blur needs an invasive BlurTargetView setup). The "accent"
 * variant renders the brand purple — near-solid, with a hint of blur on iOS.
 */
export function GlassSurface({ edge, variant = "light" }: { edge: "top" | "bottom"; variant?: "light" | "accent" }) {
  if (variant === "accent") {
    // A visible bottom edge — without it, accent-coloured content (e.g. a
    // primary button) scrolling under the solid accent header merges into it.
    if (Platform.OS === "ios") {
      return <BlurView tint="dark" intensity={40} style={[StyleSheet.absoluteFill, s.glassAccentIos, s.accentEdge]} />;
    }
    return <View style={[StyleSheet.absoluteFill, s.glassAccent, s.accentEdge]} />;
  }
  const hairline = edge === "top" ? s.glassBorderBottom : s.glassBorderTop;
  if (Platform.OS === "ios") {
    return <BlurView tint="light" intensity={70} style={[StyleSheet.absoluteFill, s.glassIos, hairline]} />;
  }
  return <View style={[StyleSheet.absoluteFill, s.glassFallback, hairline]} />;
}

/**
 * Lets a focused field ask the enclosing Screen to scroll it clear of the
 * keyboard. Provided by Screen; null outside one (e.g. login's standalone
 * layout), where consumers simply no-op.
 */
export const FieldFocusContext = createContext<((input: TextInput | null) => void) | null>(null);

export function Screen({
  children,
  refreshing,
  onRefresh,
  scroll = true,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  scroll?: boolean;
}) {
  // Inside the tab navigator the header/tab bar float transparently over the
  // content, so scrollable screens pad by their heights; stack screens (no tab
  // bar context) keep opaque headers and the plain padding.
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const tabBarHeight = useContext(BottomTabBarHeightContext) ?? 0;
  const inTabs = tabBarHeight > 0;
  const inset = inTabs
    ? { paddingTop: headerHeight + 16, paddingBottom: tabBarHeight + 24 }
    : undefined;

  const scrollRef = useRef<ScrollView>(null);
  const scrollYRef = useRef(0);

  // Scroll the focused input above the keyboard. Neither OS does this for a
  // plain ScrollView: Android's built-in reveal needs a real window resize
  // (gone under edge-to-edge) and iOS never had one. Window coordinates make
  // it self-correcting — if the OS already moved the field clear, overlap ≤ 0.
  const ensureVisible = useCallback((input?: TextInput | null) => {
    const target = input ?? (TextInput.State.currentlyFocusedInput() as TextInput | null);
    const keyboard = Keyboard.metrics();
    if (!target || !keyboard) return;
    // Wait out the keyboard-driven relayout (the avoider's padding applies on a
    // later frame) — measuring or scrolling before it settles clamps short.
    setTimeout(() => {
      if (!target.isFocused()) return;
      target.measureInWindow((_x, y, _w, h) => {
        const overlap = y + h + 24 - keyboard.screenY;
        if (overlap > 0) {
          scrollRef.current?.scrollTo({ y: Math.max(0, scrollYRef.current + overlap), animated: true });
        }
      });
    }, 80);
  }, []);

  // The tap that OPENS the keyboard: focus fires before the keyboard has a
  // frame, so the reveal can only run once it reports shown.
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", () => ensureVisible());
    return () => sub.remove();
  }, [ensureVisible]);

  if (!scroll) return <View style={s.screen}>{children}</View>;
  return (
    // Keyboard avoidance lives here so every screen gets it. "padding" on BOTH
    // platforms: under edge-to-edge Android the window no longer resizes for the
    // keyboard, so without this the scroll area keeps its full height and the
    // bottom-most fields have no room to scroll clear — the avoider's overlap
    // math zeroes itself out on devices where the window does still resize.
    // Offset: in tabs the view runs under the translucent header from window top
    // (0); in stacks it starts below the opaque header (headerHeight).
    <KeyboardAvoidingView
      style={s.screen}
      behavior="padding"
      keyboardVerticalOffset={inTabs ? 0 : headerHeight}
    >
      <ScrollView
        ref={scrollRef}
        style={s.screenScroll}
        contentContainerStyle={[s.screenContent, inset]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onScroll={(e) => {
          scrollYRef.current = e.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        scrollIndicatorInsets={inTabs ? { top: headerHeight, bottom: tabBarHeight } : undefined}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={!!refreshing}
              onRefresh={onRefresh}
              tintColor={colors.accent}
              progressViewOffset={inTabs ? headerHeight : undefined}
            />
          ) : undefined
        }
      >
        <FieldFocusContext.Provider value={ensureVisible}>{children}</FieldFocusContext.Provider>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function Card({
  children,
  onPress,
  style,
}: {
  children: ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [s.card, style, pressed && s.cardPressed]}>
        {children}
      </Pressable>
    );
  }
  return <View style={[s.card, style]}>{children}</View>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={s.sectionTitle}>{children}</Text>;
}

export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={s.infoRow}>
      <Text style={s.infoLabel}>{label}</Text>
      {typeof value === "string" || typeof value === "number" ? (
        <Text style={s.infoValue}>{value === "" ? "—" : value}</Text>
      ) : (
        <View style={s.infoValueWrap}>{value}</View>
      )}
    </View>
  );
}

// ── Feedback ──────────────────────────────────────────────────────────────────

export function LoadingView() {
  return (
    <View style={s.center}>
      <ActivityIndicator size="large" color={colors.accent} />
    </View>
  );
}

export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return <Text style={s.errorText}>{message}</Text>;
}

/** Dims the stale list during filter/search/page refetches — no layout shift. */
export function ListFade({ dimmed, children }: { dimmed: boolean; children: ReactNode }) {
  return <View style={[s.listFade, dimmed && s.listFadeDimmed]}>{children}</View>;
}

// ── Skeletons ─────────────────────────────────────────────────────────────────

/** Pulsing placeholder block — compose these into per-screen loading layouts. */
export function Skeleton({
  width = "100%",
  height = 12,
  radius = 6,
  style,
}: {
  width?: ViewStyle["width"];
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const [anim] = useState(() => new Animated.Value(0.45));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.45, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);
  return (
    <Animated.View
      style={[
        { width, height, borderRadius: radius, backgroundColor: colors.mutedSoft, opacity: anim },
        style,
      ]}
    />
  );
}

export function CardSkeleton() {
  return (
    <Card>
      <Skeleton width="40%" />
      <Skeleton width="85%" height={15} />
      <Skeleton width="60%" height={11} />
    </Card>
  );
}

export function ListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </>
  );
}

export function DetailSkeleton() {
  return (
    <>
      <Card>
        <Skeleton width="35%" height={14} />
        <Skeleton width="75%" height={18} />
        <Skeleton width="50%" />
      </Card>
      <ListSkeleton count={4} />
    </>
  );
}

export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={s.empty}>
      <Text style={s.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={s.emptySubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

// ── Controls ──────────────────────────────────────────────────────────────────

export function Badge({ status, label }: { status: string; label?: string }) {
  const tone = toneColors(statusTone(status));
  return (
    <View style={[s.badge, { backgroundColor: tone.bg }]}>
      <Text style={[s.badgeText, { color: tone.fg }]}>{label ?? titleCase(status)}</Text>
    </View>
  );
}

export function Button({
  title,
  onPress,
  variant = "primary",
  disabled,
  loading,
  small,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const inactive = disabled || loading;
  const base: StyleProp<ViewStyle>[] = [s.button, small && s.buttonSmall, style];
  if (variant === "primary") base.push({ backgroundColor: colors.accent });
  if (variant === "secondary") base.push(s.buttonSecondary);
  if (variant === "danger") base.push({ backgroundColor: colors.danger });
  if (variant === "ghost") base.push(s.buttonGhost);
  if (inactive) base.push({ opacity: 0.5 });
  const textColor =
    variant === "secondary" ? colors.text : variant === "ghost" ? colors.accent : "#ffffff";
  return (
    <Pressable onPress={onPress} disabled={inactive} style={({ pressed }) => [...base, pressed && !inactive && { opacity: 0.8 }]}>
      {loading ? (
        <ActivityIndicator size="small" color={textColor} />
      ) : (
        <Text style={[s.buttonText, small && s.buttonTextSmall, { color: textColor }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Input({
  label,
  required,
  style,
  ...props
}: TextInputProps & { label?: string; required?: boolean }) {
  const ensureVisible = useContext(FieldFocusContext);
  const inputRef = useRef<TextInput>(null);
  return (
    <View style={s.inputWrap}>
      {label ? (
        <Text style={s.inputLabel}>
          {label}
          {required ? <Text style={s.requiredStar}> *</Text> : null}
        </Text>
      ) : null}
      <TextInput
        ref={inputRef}
        placeholderTextColor={colors.faint}
        style={[s.input, props.multiline && s.inputMultiline, style]}
        {...props}
        onFocus={(e) => {
          props.onFocus?.(e);
          // Tapping a field with the keyboard already up fires no keyboard
          // event — the reveal has to come from the focus itself.
          ensureVisible?.(inputRef.current);
        }}
        onContentSizeChange={(e) => {
          props.onContentSizeChange?.(e);
          // A growing multiline box (reason fields) sinks line by line under
          // the keyboard as text wraps — keep the caret's line clear.
          if (props.multiline && inputRef.current?.isFocused()) ensureVisible?.(inputRef.current);
        }}
      />
    </View>
  );
}

/** Password field with an eye toggle to show/hide what's typed. */
export function PasswordInput({
  label,
  required,
  style,
  ...props
}: TextInputProps & { label?: string; required?: boolean }) {
  const [show, setShow] = useState(false);
  const ensureVisible = useContext(FieldFocusContext);
  const inputRef = useRef<TextInput>(null);
  return (
    <View style={s.inputWrap}>
      {label ? (
        <Text style={s.inputLabel}>
          {label}
          {required ? <Text style={s.requiredStar}> *</Text> : null}
        </Text>
      ) : null}
      <View style={s.pwRow}>
        <TextInput
          ref={inputRef}
          placeholderTextColor={colors.faint}
          secureTextEntry={!show}
          autoCapitalize="none"
          style={[s.input, s.pwInput, style]}
          {...props}
          onFocus={(e) => {
            props.onFocus?.(e);
            ensureVisible?.(inputRef.current);
          }}
        />
        <Pressable style={s.pwEye} hitSlop={8} onPress={() => setShow((v) => !v)}>
          <Ionicons name={show ? "eye-off" : "eye"} size={18} color={colors.muted} />
        </Pressable>
      </View>
    </View>
  );
}

export function Segmented({
  options,
  value,
  onChange,
}: {
  options: Array<{ key: string; label: string }>;
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <View style={s.segmented}>
      {options.map((opt) => {
        const active = opt.key === value;
        return (
          <Pressable
            key={opt.key}
            onPress={() => onChange(opt.key)}
            style={[s.segment, active && s.segmentActive]}
          >
            <Text style={[s.segmentText, active && s.segmentTextActive]} numberOfLines={1}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chips({
  options,
  value,
  onChange,
}: {
  options: Array<{ key: string; label: string }>;
  value: string | null;
  onChange: (key: string) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
      {options.map((opt) => {
        const active = opt.key === value;
        return (
          <Pressable
            key={opt.key}
            onPress={() => onChange(opt.key)}
            style={[s.chip, active && s.chipActive]}
          >
            <Text style={[s.chipText, active && s.chipTextActive]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function Pager({
  page,
  totalPages,
  onPage,
  total,
  label,
}: {
  page: number;
  totalPages: number;
  onPage: (next: number) => void;
  /** When provided, renders the web Pagination's "Total: N {label}" line. */
  total?: number;
  label?: string;
}) {
  const showControls = totalPages > 1;
  if (!showControls && total === undefined) return null;
  return (
    <View style={s.pagerWrap}>
      {total !== undefined ? (
        <Text style={s.pagerTotal}>
          {/* Singularize the label for exactly one, like the web's Pagination. */}
          Total: {total} {total === 1 ? (label ?? "items").replace(/s$/, "") : (label ?? "items")}
        </Text>
      ) : null}
      {showControls ? (
        <View style={s.pager}>
          <Button title="Previous" variant="secondary" small disabled={page <= 1} onPress={() => onPage(page - 1)} />
          <Text style={s.pagerText}>
            Page {page} of {totalPages}
          </Text>
          <Button title="Next" variant="secondary" small disabled={page >= totalPages} onPress={() => onPage(page + 1)} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Compact dropdown filter (the mobile equivalent of the web's <Select>): a
 * field-style trigger showing the current option, opening a bottom-sheet list.
 */
export function Select({
  options,
  value,
  onChange,
  placeholder,
  label,
  required,
  style,
}: {
  options: { key: string; label: string }[];
  value: string | null;
  onChange: (key: string) => void;
  placeholder?: string;
  label?: string;
  required?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.key === value);
  return (
    <>
      {label ? (
        <Text style={s.inputLabel}>
          {label}
          {required ? <Text style={s.requiredStar}> *</Text> : null}
        </Text>
      ) : null}
      <Pressable style={[s.selectTrigger, style]} onPress={() => setOpen(true)}>
        <Text style={[s.selectText, !current && { color: colors.faint }]} numberOfLines={1}>
          {current?.label ?? placeholder ?? "Select…"}
        </Text>
        <Ionicons name="chevron-down" size={14} color={colors.muted} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.sheetBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={s.sheet} onPress={() => undefined}>
            <ScrollView style={s.sheetScroll} contentContainerStyle={s.sheetContent}>
              {options.map((opt) => {
                const active = opt.key === value;
                return (
                  <Pressable
                    key={opt.key}
                    style={[s.sheetRow, active && s.sheetRowActive]}
                    onPress={() => {
                      onChange(opt.key);
                      setOpen(false);
                    }}
                  >
                    <Text style={[s.sheetRowText, active && s.sheetRowTextActive]}>{opt.label}</Text>
                    {active ? <Ionicons name="checkmark" size={16} color={colors.accent} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/** Lays out Selects two-up, matching the web's filter toolbar rows. */
export function FilterRow({ children }: { children: ReactNode }) {
  return <View style={s.filterRow}>{children}</View>;
}

export function Stepper({
  value,
  onChange,
  min = 0,
  max,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <View style={s.stepper}>
      <Pressable
        onPress={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        style={[s.stepBtn, value <= min && { opacity: 0.35 }]}
      >
        <Text style={s.stepBtnText}>−</Text>
      </Pressable>
      <Text style={s.stepValue}>{value}</Text>
      <Pressable
        onPress={() => onChange(max === undefined ? value + 1 : Math.min(max, value + 1))}
        disabled={max !== undefined && value >= max}
        style={[s.stepBtn, max !== undefined && value >= max && { opacity: 0.35 }]}
      >
        <Text style={s.stepBtnText}>+</Text>
      </Pressable>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  screenScroll: { flex: 1 },
  screenContent: { padding: 16, paddingBottom: 40, gap: 12 },
  glassIos: { backgroundColor: "rgba(255,255,255,0.55)" },
  glassFallback: { backgroundColor: "rgba(255,255,255,0.92)" },
  glassAccentIos: { backgroundColor: "rgba(123,110,240,0.88)" },
  glassAccent: { backgroundColor: colors.accent },
  accentEdge: {
    borderBottomWidth: 2,
    borderBottomColor: "rgba(30, 18, 80, 0.35)",
    elevation: 8, // Android: soft drop shadow so content reads as sliding UNDER the header
    shadowColor: "#1e1250",
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  glassBorderBottom: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  glassBorderTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  listFade: { gap: 12 },
  listFadeDimmed: { opacity: 0.45 },
  pagerWrap: { gap: 6, marginTop: 4 },
  pagerTotal: { fontSize: 12, color: colors.muted, textAlign: "center" },
  pager: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 16 },
  pagerText: { fontSize: 13, fontWeight: "600", color: colors.muted },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 8,
  },
  cardPressed: { opacity: 0.85 },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.6, marginTop: 6 },
  infoRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12, paddingVertical: 2 },
  infoLabel: { color: colors.muted, fontSize: 14, flexShrink: 0 },
  infoValue: { color: colors.text, fontSize: 14, fontWeight: "500", flex: 1, textAlign: "right" },
  infoValueWrap: { flex: 1, alignItems: "flex-end" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  errorText: { color: colors.danger, fontSize: 14 },
  empty: { alignItems: "center", paddingVertical: 32, gap: 4 },
  emptyTitle: { fontSize: 15, fontWeight: "600", color: colors.text },
  emptySubtitle: { fontSize: 13, color: colors.muted, textAlign: "center" },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: "flex-start" },
  badgeText: { fontSize: 12, fontWeight: "600" },
  button: {
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonSmall: { paddingVertical: 8, paddingHorizontal: 12 },
  buttonSecondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  buttonGhost: { backgroundColor: "transparent" },
  buttonText: { fontSize: 15, fontWeight: "600" },
  buttonTextSmall: { fontSize: 13 },
  inputWrap: { gap: 6 },
  inputLabel: { fontSize: 13, fontWeight: "600", color: colors.muted },
  requiredStar: { color: colors.danger, fontWeight: "700" },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    color: colors.text,
  },
  inputMultiline: { minHeight: 80, textAlignVertical: "top" },
  pwRow: { position: "relative" },
  pwInput: { paddingRight: 44 },
  pwEye: { position: "absolute", right: 12, top: 0, bottom: 0, justifyContent: "center" },
  segmented: {
    flexDirection: "row",
    backgroundColor: colors.mutedSoft,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 3,
    gap: 3,
  },
  segment: { flex: 1, borderRadius: 10, paddingVertical: 8, alignItems: "center" },
  // Accent-filled active state, matching the web's tab pills and the Chips row.
  segmentActive: { backgroundColor: colors.accent },
  segmentText: { fontSize: 13, fontWeight: "600", color: colors.muted },
  segmentTextActive: { color: "#ffffff", fontWeight: "700" },
  chips: { gap: 8, paddingVertical: 2 },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { fontSize: 13, fontWeight: "600", color: colors.muted },
  chipTextActive: { color: "#ffffff" },
  selectTrigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flex: 1,
  },
  selectText: { fontSize: 13, fontWeight: "600", color: colors.text, flexShrink: 1 },
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(23,23,28,0.45)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    paddingBottom: 24,
  },
  sheetScroll: { maxHeight: 420 },
  sheetContent: { paddingHorizontal: 12, paddingVertical: 8 },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 13,
    borderRadius: 12,
  },
  sheetRowActive: { backgroundColor: colors.accentSoft },
  sheetRowText: { fontSize: 15, color: colors.text },
  sheetRowTextActive: { fontWeight: "700", color: colors.accent },
  filterRow: { flexDirection: "row", gap: 8 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBtnText: { fontSize: 18, fontWeight: "700", color: colors.text, lineHeight: 20 },
  stepValue: { minWidth: 28, textAlign: "center", fontSize: 15, fontWeight: "700", color: colors.text },
});
