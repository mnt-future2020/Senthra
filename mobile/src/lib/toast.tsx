import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors } from "./theme";

// App-wide toast notifications, mirroring the web dashboard's action toasts:
// dark card, tinted icon, slides in under the status bar, auto-dismisses.
// Use via `const toast = useToast(); toast.success("Transfer approved.");`

type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  /** How many times this exact message+kind fired while it was on screen. */
  count: number;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS: Record<ToastKind, { name: keyof typeof Ionicons.glyphMap; color: string }> = {
  success: { name: "checkmark-circle", color: "#4ade80" },
  error: { name: "alert-circle", color: "#f87171" },
  info: { name: "information-circle", color: "#a5b4fc" },
};

const AUTO_DISMISS_MS = 3500;
const MAX_VISIBLE = 3;

function ToastCard({ item, onDone }: { item: ToastItem; onDone: (id: number) => void }) {
  // useState initializer (not useRef.current) — stable instance, render-safe for the lint rules.
  const [anim] = useState(() => new Animated.Value(0));
  const dismissed = useRef(false);

  const dismiss = useCallback(() => {
    if (dismissed.current) return;
    dismissed.current = true;
    Animated.timing(anim, { toValue: 0, duration: 160, useNativeDriver: true }).start(() =>
      onDone(item.id),
    );
  }, [anim, item.id, onDone]);

  // Keyed on count too: a merged repeat restarts the clock, so the toast lives a
  // full window from the LATEST occurrence (web toastStack parity).
  useEffect(() => {
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, damping: 16, stiffness: 220 }).start();
    const t = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [anim, dismiss, item.count]);

  const icon = ICONS[item.kind];
  return (
    <Animated.View
      style={[
        s.card,
        {
          opacity: anim,
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] }) }],
        },
      ]}
    >
      <Pressable style={s.cardInner} onPress={dismiss}>
        <Ionicons name={icon.name} size={19} color={icon.color} />
        <Text style={s.message} numberOfLines={3}>
          {item.message}
        </Text>
        {item.count > 1 ? (
          <View style={s.countBadge}>
            <Text style={s.countBadgeText}>×{item.count}</Text>
          </View>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const insets = useSafeAreaInsets();

  const push = useCallback((kind: ToastKind, message: string) => {
    setToasts((prev) => {
      // A repeat of a toast still on screen MERGES into it (dedup key: text +
      // kind) — the count badge ticks up instead of the stack filling with
      // copies, and the card restarts its own dismiss clock on the bump.
      const existing = prev.find((t) => t.message === message && t.kind === kind);
      if (existing) {
        return prev.map((t) => (t === existing ? { ...t, count: t.count + 1 } : t));
      }
      return [...prev.slice(-(MAX_VISIBLE - 1)), { id: nextId.current++, kind, message, count: 1 }];
    });
  }, []);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push("success", m),
      error: (m) => push("error", m),
      info: (m) => push("info", m),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <View pointerEvents="box-none" style={[s.host, { top: insets.top + 10 }]}>
        {toasts.map((t) => (
          <ToastCard key={t.id} item={t} onDone={remove} />
        ))}
      </View>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

const s = StyleSheet.create({
  host: { position: "absolute", left: 16, right: 16, gap: 8, zIndex: 1000 },
  card: {
    borderRadius: 14,
    backgroundColor: colors.text,
    shadowColor: "#000000",
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  cardInner: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  message: { flex: 1, fontSize: 13.5, fontWeight: "600", color: "#ffffff", lineHeight: 18 },
  countBadge: {
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.18)",
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  countBadgeText: { fontSize: 11, fontWeight: "800", color: "#ffffff", fontVariant: ["tabular-nums"] },
});
