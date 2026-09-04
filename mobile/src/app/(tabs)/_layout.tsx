import React from "react";
import { Redirect, Tabs } from "expo-router";
import type { BottomTabBarButtonProps } from "expo-router/js-tabs";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "@/lib/auth";
import { useBranding } from "@/lib/branding";
import { usePushNotifications } from "@/lib/usePushNotifications";
import { Button, GlassSurface, LoadingView } from "@/components/ui";
import { colors } from "@/lib/theme";

// Dashboard sits centre in the bar (3rd of 5) but stays the tab you land on.
export const unstable_settings = { initialRouteName: "overview" };

const CENTER_SIZE = 56;
const ACCENT_MID = "#c9c3f8"; // light accent for the inner ring, like the reference

/**
 * Raised centre tab for the Dashboard — ported from the leats-mobile
 * CenterButton: two tight dashed-border rings (slow clockwise outer, fast
 * counter-clockwise inner), gradient button, squish-spring on press.
 */
function DashboardTabButton(props: BottomTabBarButtonProps) {
  const { onPress } = props;
  // This react-navigation version reports focus via aria-selected, not accessibilityState.
  const focused = props["aria-selected"] ?? false;
  const [btnScale] = React.useState(() => new Animated.Value(1));
  const [ring1Rotate] = React.useState(() => new Animated.Value(0));
  const [ring2Rotate] = React.useState(() => new Animated.Value(0));

  // Always-running spins (start on mount, never stop) — same timings as leats.
  React.useEffect(() => {
    const loop1 = Animated.loop(
      Animated.timing(ring1Rotate, { toValue: 1, duration: 2800, useNativeDriver: true }),
    );
    const loop2 = Animated.loop(
      Animated.timing(ring2Rotate, { toValue: -1, duration: 1800, useNativeDriver: true }),
    );
    loop1.start();
    loop2.start();
    return () => {
      loop1.stop();
      loop2.stop();
    };
  }, [ring1Rotate, ring2Rotate]);

  React.useEffect(() => {
    Animated.spring(btnScale, {
      toValue: focused ? 1.08 : 1,
      useNativeDriver: true,
      damping: 14,
      stiffness: 200,
    }).start();
  }, [focused, btnScale]);

  const handlePress = (e: Parameters<NonNullable<BottomTabBarButtonProps["onPress"]>>[0]) => {
    Animated.sequence([
      Animated.spring(btnScale, { toValue: 0.84, useNativeDriver: true, damping: 4, stiffness: 700 }),
      Animated.spring(btnScale, {
        toValue: focused ? 1.08 : 1,
        useNativeDriver: true,
        damping: 12,
        stiffness: 220,
      }),
    ]).start();
    onPress?.(e);
  };

  const spin1 = ring1Rotate.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const spin2 = ring2Rotate.interpolate({ inputRange: [-1, 0], outputRange: ["-360deg", "0deg"] });

  return (
    <Pressable style={s.centerWrap} onPress={handlePress} accessibilityRole="button" accessibilityLabel="Dashboard">
      <Animated.View style={[s.centerOuter, { transform: [{ scale: btnScale }] }]}>
        {/* Ring 1 — dashed, slow clockwise */}
        <Animated.View pointerEvents="none" style={[s.orbitRing, s.orbitRing1, { transform: [{ rotate: spin1 }] }]} />
        {/* Ring 2 — dashed, fast counter-clockwise */}
        <Animated.View pointerEvents="none" style={[s.orbitRing, s.orbitRing2, { transform: [{ rotate: spin2 }] }]} />
        {/* Active look unchanged; unselected flips to a white circle with purple icon. */}
        <LinearGradient
          colors={focused ? ["#8d82f4", "#5b4ce0"] : ["#ffffff", "#ffffff"]}
          start={{ x: 0.15, y: 0 }}
          end={{ x: 0.85, y: 1 }}
          style={s.centerGradient}
        >
          {/* Idle icon matches the other tabs' inactive grey */}
          <Ionicons name="grid" size={24} color={focused ? "#ffffff" : colors.faint} />
        </LinearGradient>
      </Animated.View>
    </Pressable>
  );
}

/** Server-configured brand logo (white chip so any logo reads on purple); "S" wordmark fallback. */
function HeaderLogo() {
  const branding = useBranding();
  if (branding?.logoUrl) {
    return (
      <View style={s.logoChip}>
        <Image source={{ uri: branding.logoUrl }} style={s.logoImage} contentFit="contain" />
      </View>
    );
  }
  return (
    <View style={s.logoBadge}>
      <Text style={s.logoBadgeText}>S</Text>
    </View>
  );
}

export default function TabsLayout() {
  const { principal, loading, logout, can } = useAuth();
  usePushNotifications();

  if (loading) return <LoadingView />;
  if (!principal) return <Redirect href="/login" />;
  if (principal.type === "user" && principal.mustResetPassword) {
    return <Redirect href="/set-password" />;
  }
  // The mobile app is the engineer surface — admin/customer accounts use the web dashboard.
  if (principal.type !== "user") {
    return (
      <View style={s.blocked}>
        <Text style={s.blockedTitle}>Engineer accounts only</Text>
        <Text style={s.blockedText}>
          This app is for field engineers. Please use the Senthra web dashboard for
          {principal.type === "customer" ? " the customer portal." : " admin access."}
        </Text>
        <Button title="Sign out" variant="secondary" onPress={() => void logout()} />
      </View>
    );
  }
  // Being staff isn't enough — this app IS the Engineer Portal, so it needs the portal's base
  // permission, exactly like the web's EngineerGuard. Without this check any staff account
  // (helpdesk, finance, HR) reached the tabs and got a shell where every request 403s, which
  // reads as a broken app rather than "not for you". The backend was never at risk; this is
  // about showing the right thing.
  if (!can("engineer.dashboard.view")) {
    return (
      <View style={s.blocked}>
        <Text style={s.blockedTitle}>No engineer access</Text>
        <Text style={s.blockedText}>
          Your role does not include the Engineer Portal. Ask an administrator to assign you a
          field-operations role, or use the Senthra web dashboard.
        </Text>
        <Button title="Sign out" variant="secondary" onPress={() => void logout()} />
      </View>
    );
  }

  return (
    <Tabs
      screenOptions={{
        // Header and tab bar float over the content; the header is brand
        // purple, the tab bar frosted glass. Screen pads scrollable content
        // by their heights so nothing starts hidden.
        headerTransparent: true,
        headerBackground: () => <GlassSurface edge="top" variant="accent" />,
        headerTitleStyle: { fontWeight: "700", color: "#ffffff" },
        headerTintColor: "#ffffff",
        headerRight: () => <HeaderLogo />,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.faint,
        // The bar floats over content, so when Android's adjustResize shrinks the
        // window it would ride up and sit exactly over the focused input — hide it
        // while the keyboard is open instead. (iOS keyboards cover the bar anyway.)
        tabBarHideOnKeyboard: true,
        tabBarStyle: {
          position: "absolute",
          backgroundColor: "transparent",
          borderTopWidth: 0,
          elevation: 0,
        },
        tabBarBackground: () => (
          <>
            <GlassSurface edge="bottom" />
            {/* Gradient hairline top border, like the leats bar */}
            <LinearGradient
              colors={[ACCENT_MID, colors.accent, ACCENT_MID]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={s.barTopBorder}
            />
          </>
        ),
      }}
    >
      <Tabs.Screen
        name="jobs"
        options={{
          title: "Jobs",
          tabBarIcon: ({ color, size }) => <Ionicons name="briefcase" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="stock"
        options={{
          title: "My Stock",
          tabBarIcon: ({ color, size }) => <Ionicons name="cube" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="overview"
        options={{
          title: "Dashboard",
          tabBarButton: (props) => <DashboardTabButton {...props} />,
        }}
      />
      <Tabs.Screen
        name="requests"
        options={{
          title: "Requests",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="swap-horizontal" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: "Account",
          tabBarIcon: ({ color, size }) => <Ionicons name="person" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}

const s = StyleSheet.create({
  blocked: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 12,
  },
  blockedTitle: { fontSize: 18, fontWeight: "700", color: colors.text },
  blockedText: { fontSize: 14, color: colors.muted, textAlign: "center" },
  logoChip: {
    backgroundColor: "#ffffff",
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginRight: 16,
  },
  logoImage: { width: 64, height: 22 },
  logoBadge: {
    width: 30,
    height: 30,
    borderRadius: 10,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 16,
  },
  logoBadgeText: { fontSize: 16, fontWeight: "800", color: colors.accent },
  barTopBorder: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1.5,
    opacity: 0.55,
  },
  centerWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  // Just wide enough for the outermost ring, floated above the glass bar.
  centerOuter: {
    width: CENTER_SIZE + 16,
    height: CENTER_SIZE + 16,
    marginTop: -30,
    alignItems: "center",
    justifyContent: "center",
  },
  orbitRing: {
    position: "absolute",
    borderRadius: 999,
    borderStyle: "dashed",
  },
  orbitRing1: {
    width: CENTER_SIZE + 12,
    height: CENTER_SIZE + 12,
    borderWidth: 1.6,
    borderColor: colors.accent,
    opacity: 0.4,
  },
  orbitRing2: {
    width: CENTER_SIZE + 6,
    height: CENTER_SIZE + 6,
    borderWidth: 1.2,
    borderColor: ACCENT_MID,
    opacity: 0.7,
  },
  centerGradient: {
    width: CENTER_SIZE,
    height: CENTER_SIZE,
    borderRadius: CENTER_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.accent,
    shadowOpacity: 0.38,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
});
