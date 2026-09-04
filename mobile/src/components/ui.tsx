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
// As of SDK 56 Expo Router vendors react-navigation rather than depending on it,
// so these contexts come from Expo Router's own subpaths. Importing the standalone
// @react-navigation packages here would give us a second context instance that the
// navigator never populates.
import { HeaderHeightContext } from "expo-router/react-navigation";
import { BottomTabBarHeightContext } from "expo-router/js-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  footer,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  scroll?: boolean;
  /**
   * Pinned to the bottom of the viewport instead of scrolling away with the content — the web's
   * sticky form footer, which is where every composer's primary action lives.
   *
   * On a composer this is not decoration. The action is the LAST thing in a long scroll (search
   * results, a cart of steppers, reason, attachments), so the engineer had to scroll past all of it
   * to send, and after a validation error scroll back down again to retry.
   *
   * Deliberately OUTSIDE the keyboard avoider: it holds the bottom of the window and the keyboard
   * simply covers it. Riding up on top of the keyboard would put the primary action against the key
   * rows while the engineer is mid-sentence in the reason box — a send they have not finished
   * composing, one thumb-width from the letters they are typing. The avoider still shrinks the
   * scroll area (it measures its OWN frame, so the footer's height is already accounted for), so a
   * focused field still scrolls clear.
   */
  footer?: ReactNode;
}) {
  // Inside the tab navigator the header/tab bar float transparently over the
  // content, so scrollable screens pad by their heights; stack screens (no tab
  // bar context) keep opaque headers and the plain padding.
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const tabBarHeight = useContext(BottomTabBarHeightContext) ?? 0;
  const inTabs = tabBarHeight > 0;
  // EXACTLY the bar's height, with nothing added. That height is react-navigation's own
  // (TABBAR_HEIGHT_UIKIT 49 + the bottom safe-area inset), and it is the whole distance the last row
  // has to clear — the glass starts there, so a card ending at that line is flush against the bar's
  // top edge, not hidden by it. Any resting gap on top of it is dead space on every tab, and on a
  // handset already giving up ~97dp to the tab bar and the system nav there is none to spare.
  const inset = inTabs
    ? { paddingTop: headerHeight + 16, paddingBottom: tabBarHeight }
    : undefined;
  // The home indicator / gesture bar. Only the footer needs it: without a footer the content's own
  // paddingBottom (or the tab-bar inset above) already clears the bottom of the window.
  //
  // MAX, not a sum. Under edge-to-edge the window already extends behind the navigation bar, so this
  // inset IS the strip the button must sit above — adding a resting gap on top of it stacks the two
  // and leaves a band of dead white under the action. The resting gap only applies where there is no
  // inset to clear (a device with no bar, or an inset smaller than the gap).
  const safeBottom = Math.max(12, useSafeAreaInsets().bottom);

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
    <View style={s.screen}>
      {/* Keyboard avoidance lives here so every screen gets it. "padding" on BOTH platforms: under
          edge-to-edge Android the window no longer resizes for the keyboard, so without this the
          scroll area keeps its full height and the bottom-most fields have no room to scroll clear
          — the avoider's overlap math zeroes itself out on devices where the window does still
          resize. Offset: in tabs the view runs under the translucent header from window top (0); in
          stacks it starts below the opaque header (headerHeight).

          It wraps the SCROLL AREA ONLY, so a pinned footer stays put while the keyboard covers it.
          RN measures the avoider's own frame, so the footer's height is already netted off the
          padding it applies. */}
      <KeyboardAvoidingView
        style={s.screenBody}
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
      {/* No FieldFocusContext here: nothing in the footer can be scrolled clear of the keyboard,
          because the footer is not in the scroll area. It holds actions, not fields. */}
      {footer ? <View style={[s.screenFooter, { paddingBottom: safeBottom }]}>{footer}</View> : null}
    </View>
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

export function EmptyState({
  title,
  subtitle,
  icon,
}: {
  title: string;
  subtitle?: string;
  /** Optional glyph above the title, matching the web's `<EmptyState icon={…}>`. Decorative only —
   *  the title already carries the meaning, so it is hidden from screen readers by the caller. */
  icon?: ReactNode;
}) {
  return (
    <View style={s.empty}>
      {icon ? <View style={s.emptyIcon}>{icon}</View> : null}
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

/**
 * "RENTAL" — the marker on any row that names HIRED kit rather than company stock.
 *
 * A one-word tag rather than a colour or an icon alone, because the distinction it draws is not a
 * shade of the same thing: company stock is ours and a hire is somebody else's equipment, billing by
 * the day, owed back to one specific depot. Every list that can mix the two pools carries this on
 * the rental rows — the ported twin of the web's `RentalBadge`.
 */
export function RentalBadge() {
  return (
    <View style={s.rentalBadge}>
      <Ionicons name="timer-outline" size={10} color={colors.accent} />
      <Text style={s.rentalBadgeText}>RENTAL</Text>
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

/**
 * A search field: the same Input with a magnifier sitting inside its left edge.
 *
 * The glyph is what makes a text box read as "search" before anything is typed. Placeholder copy
 * alone doesn't do it — it disappears the moment the field has content, and on a list screen the box
 * is then indistinguishable from any other input. Every search box in the app goes through here so
 * they cannot drift apart.
 *
 * Deliberately no `label`: the icon IS the label, and the absolutely-positioned glyph is centred
 * against the wrapper, which a label above the field would push out of alignment.
 */
export function SearchInput({ style, ...props }: Omit<TextInputProps, "multiline">) {
  return (
    <View>
      <Input
        autoCapitalize="none"
        returnKeyType="search"
        {...props}
        style={[s.searchInput, style]}
      />
      {/* pointerEvents none so the glyph never eats a tap meant for the field behind it. */}
      <View style={s.searchIcon} pointerEvents="none">
        <Ionicons name="search" size={16} color={colors.faint} />
      </View>
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
  options: { key: string; label: string }[];
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
  /**
   * `icon` is a FUNCTION of the colour rather than a ready-made node, because a chip inverts when it
   * becomes active (muted on white → white on accent). A pre-built element would carry whatever colour
   * it was created with and sit wrong in one of the two states; handing the caller the colour lets the
   * chip stay the single owner of its own palette.
   */
  options: { key: string; label: string; icon?: (color: string) => ReactNode }[];
  value: string | null;
  onChange: (key: string) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
      {options.map((opt) => {
        const active = opt.key === value;
        const tint = active ? "#ffffff" : colors.muted;
        return (
          <Pressable
            key={opt.key}
            onPress={() => onChange(opt.key)}
            style={[s.chip, active && s.chipActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={opt.label}
          >
            {opt.icon ? opt.icon(tint) : null}
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

/**
 * Confirmation dialog for destructive or irreversible actions — the mobile twin of the web's
 * ConfirmDialog, with the same props so a screen reads the same on both surfaces.
 *
 * An in-app modal rather than `Alert.alert`: the OS alert is the system's chrome, not the app's, so
 * it carries none of the brand, cannot show a busy state on its confirm button, and on Android
 * renders its buttons in the platform's order rather than the one the rest of Senthra uses. This is
 * the surface that asks before something cannot be undone, so it should look like the app asking.
 *
 * Dismissal — backdrop tap and the Android back button — is refused while `busy`: there is nothing
 * safe to cancel once the action is in flight, and closing would leave the caller's state stranded.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dismiss = () => {
    if (!busy) onClose();
  };
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={dismiss}>
      <Pressable style={s.dialogBackdrop} onPress={dismiss}>
        {/* Swallows the tap so pressing the panel itself never dismisses. */}
        <Pressable style={s.dialog} onPress={() => undefined}>
          <View style={s.dialogHead}>
            <View style={[s.dialogIcon, danger ? s.dialogIconDanger : s.dialogIconAccent]}>
              <Ionicons
                name="alert-circle-outline"
                size={20}
                color={danger ? colors.danger : colors.accent}
              />
            </View>
            <View style={s.flexShrink}>
              <Text style={s.dialogTitle}>{title}</Text>
              {message ? <Text style={s.dialogMessage}>{message}</Text> : null}
            </View>
          </View>
          <View style={s.dialogActions}>
            {/* Cancel FIRST, and it is the plain one. The destructive button is never the resting
                target of a mis-tap on a dialog whose whole purpose is to catch one. */}
            <Button title={cancelLabel} variant="secondary" small style={s.flex1} disabled={busy} onPress={onClose} />
            <Button
              title={confirmLabel}
              variant={danger ? "danger" : "primary"}
              small
              style={s.flex1}
              loading={busy}
              onPress={onConfirm}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Lays out Selects two-up, matching the web's filter toolbar rows. */
export function FilterRow({ children }: { children: ReactNode }) {
  return <View style={s.filterRow}>{children}</View>;
}

// ── Search + folded filters ────────────────────────────────────────────────────────────────────
//
// The search box keeps the row; every other filter moves behind one trigger beside it. On a phone a
// second row of Selects costs a whole card's worth of the list you came to read, and most of those
// Selects are set once and left.
//
// The COUNT on the trigger is the whole bargain, and the reason this is safe: hiding a filter is
// only acceptable if you can still tell at a glance that it is on. Without it a list silently shows
// a subset and nobody knows why it looks short — which on a job list reads as "I have no work today".
// Same reasoning as the web's FilterPopover, which is where this pattern comes from.

/**
 * The trigger + its sheet, on its own. Use directly where a surface has filters but no search box
 * (the movements ledger, whose date range stays on the row outside); most screens want
 * `SearchFilterBar`, which is this sitting beside a SearchInput.
 */
export function FilterButton({
  activeCount,
  onClear,
  children,
  title = "Filters",
}: {
  /** How many of the filters inside are set to something other than their default. */
  activeCount: number;
  /** Reset every filter inside. Omit to hide the Clear action. */
  onClear?: () => void;
  children: ReactNode;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const active = activeCount > 0;
  return (
    <>
      <Pressable
        style={[s.filterBtn, active && s.filterBtnActive]}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={active ? `${title}, ${activeCount} active` : title}
      >
        <Ionicons name="options-outline" size={18} color={active ? "#ffffff" : colors.muted} />
        {active ? (
          <View style={s.filterCount}>
            <Text style={s.filterCountText}>{activeCount}</Text>
          </View>
        ) : null}
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.sheetBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={s.sheet} onPress={() => undefined}>
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle}>{title}</Text>
              {onClear && active ? (
                <Pressable onPress={onClear} hitSlop={8} accessibilityRole="button">
                  <Text style={s.sheetClear}>Clear all</Text>
                </Pressable>
              ) : null}
            </View>
            <ScrollView style={s.sheetScroll} contentContainerStyle={s.sheetContent}>
              {children}
            </ScrollView>
            {/* The sheet stays open while filters are tapped — changing two of them is one trip, not
                two — so it needs an explicit way out that isn't only the backdrop. */}
            <View style={s.sheetFooter}>
              <Button title="Done" onPress={() => setOpen(false)} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export function SearchFilterBar({
  value,
  onChangeText,
  placeholder,
  activeCount,
  onClear,
  children,
  title = "Filters",
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  activeCount: number;
  onClear?: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <View style={s.searchRow}>
      <View style={s.searchFlex}>
        <SearchInput placeholder={placeholder} value={value} onChangeText={onChangeText} />
      </View>
      <FilterButton activeCount={activeCount} onClear={onClear} title={title}>
        {children}
      </FilterButton>
    </View>
  );
}

/** One single-select filter inside a SearchFilterBar sheet: a heading plus its options as chips. */
export function FilterGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <View style={s.filterGroup}>
      <Text style={s.filterGroupLabel}>{label}</Text>
      <View style={s.filterGroupChips}>
        {options.map((opt) => {
          const on = opt.key === value;
          return (
            <Pressable
              key={opt.key}
              style={[s.filterChip, on && s.filterChipActive]}
              onPress={() => onChange(opt.key)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
            >
              <Text style={[s.filterChipText, on && s.filterChipTextActive]}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Stepper({
  value,
  onChange,
  min = 0,
  max,
  disabled,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  /** Held while the figure this stepper is capped against is still outstanding — the web's
   *  `qtyPending`. Without it a number typed before the counts land goes in uncapped. */
  disabled?: boolean;
}) {
  const downOff = disabled || value <= min;
  const upOff = disabled || (max !== undefined && value >= max);
  return (
    <View style={[s.stepper, disabled && { opacity: 0.5 }]}>
      <Pressable
        onPress={() => onChange(Math.max(min, value - 1))}
        disabled={downOff}
        style={[s.stepBtn, downOff && { opacity: 0.35 }]}
      >
        <Text style={s.stepBtnText}>−</Text>
      </Pressable>
      <Text style={s.stepValue}>{value}</Text>
      <Pressable
        onPress={() => onChange(max === undefined ? value + 1 : Math.min(max, value + 1))}
        disabled={upOff}
        style={[s.stepBtn, upOff && { opacity: 0.35 }]}
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
  // The keyboard avoider's own box: everything above a pinned footer.
  screenBody: { flex: 1 },
  // NOTE: `paddingBottom` here applies to STACK screens only — inside the tab navigator the `inset`
  // above replaces it (later entry in the style array wins). Change the inset, not this, to move the
  // gap above the tab bar.
  screenContent: { padding: 16, paddingBottom: 24, gap: 12 },
  screenFooter: {
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 8,
  },
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
  emptyIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: colors.mutedSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: { fontSize: 15, fontWeight: "600", color: colors.text },
  emptySubtitle: { fontSize: 13, color: colors.muted, textAlign: "center" },
  rentalBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    alignSelf: "flex-start",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  rentalBadgeText: { fontSize: 9, fontWeight: "800", letterSpacing: 0.8, color: colors.accent },
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
  // 12 (the input's own padding) + 16 (glyph) + 8 (breathing room) = 36.
  searchInput: { paddingLeft: 36 },
  searchIcon: { position: "absolute", left: 12, top: 0, bottom: 0, justifyContent: "center" },
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
    // Row, so an optional icon sits beside the label rather than above it (RN defaults to column).
    // Harmless for icon-less chips: a single child lays out identically either way.
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
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
  dialogBackdrop: {
    flex: 1,
    backgroundColor: "rgba(23,23,28,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  dialog: { width: "100%", maxWidth: 380, backgroundColor: colors.card, borderRadius: 20, padding: 20, gap: 18 },
  dialogHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  dialogIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  dialogIconDanger: { backgroundColor: colors.dangerSoft },
  dialogIconAccent: { backgroundColor: colors.accentSoft },
  dialogTitle: { fontSize: 16, fontWeight: "800", color: colors.text },
  dialogMessage: { fontSize: 13, color: colors.muted, marginTop: 4 },
  dialogActions: { flexDirection: "row", gap: 10 },
  // Equal halves, so neither action is the wider (and easier) target.
  flex1: { flex: 1 },
  flexShrink: { flexShrink: 1 },
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
  // `stretch`, so the button takes its height from the Input beside it rather than guessing at one.
  // A hardcoded height was wrong the moment the TextInput's real line box differed from the estimate
  // — and it would go wrong again on any font-scale setting, which a guess cannot follow.
  searchRow: { flexDirection: "row", alignItems: "stretch", gap: 8 },
  searchFlex: { flex: 1 },
  filterBtn: {
    width: 45,
    // No `height`: inside searchRow the row stretches it to match the Input. `minHeight` is the
    // floor for the standalone FilterButton (the movements ledger), which has no Input to match.
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  filterBtnActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  filterCount: {
    position: "absolute",
    top: -5,
    right: -5,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.bg,
  },
  filterCountText: { fontSize: 10, fontWeight: "800", color: "#ffffff" },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.text },
  sheetClear: { fontSize: 13, fontWeight: "700", color: colors.accent },
  sheetFooter: { paddingHorizontal: 16, paddingTop: 4 },
  filterGroup: { paddingHorizontal: 8, paddingVertical: 10, gap: 8 },
  filterGroupLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: colors.faint,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  filterGroupChips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  filterChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  filterChipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  filterChipText: { fontSize: 13, fontWeight: "600", color: colors.muted },
  filterChipTextActive: { color: colors.accent, fontWeight: "700" },
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
