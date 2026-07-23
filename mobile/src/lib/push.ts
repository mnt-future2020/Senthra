import { Platform } from "react-native";
import * as Device from "expo-device";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { registerDeviceToken, unregisterDeviceToken } from "../services/notification.service";

// Push notifications via Firebase Cloud Messaging (direct FCM path — we register
// the raw device FCM token with our backend, which sends through firebase-admin).
//
// Push is NOT supported in Expo Go (Android remote push was removed) and merely
// EVALUATING expo-notifications there crashes the app at load. So expo-notifications
// is never imported at module scope — it's lazily require()d only inside a real
// build. Importing this file is fully inert in Expo Go.

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
const supported = !isExpoGo && Device.isDevice;

type NotificationsModule = typeof import("expo-notifications");
let cachedModule: NotificationsModule | null = null;

/** Load expo-notifications only when supported — never touched in Expo Go. */
function loadNotifications(): NotificationsModule | null {
  if (!supported) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (!cachedModule) cachedModule = require("expo-notifications") as NotificationsModule;
  return cachedModule;
}

// Minimal router shape (expo-router doesn't export its Router type in this build).
interface PushRouter {
  push: (href: { pathname: string; params: Record<string, string> }) => void;
}

let handlerSet = false;
let currentToken: string | null = null;

/**
 * Ask for permission, ensure the Android channel exists, get this device's FCM
 * token and register it with the backend. No-op in Expo Go / on simulators.
 */
export async function registerForPush(): Promise<void> {
  const Notifications = loadNotifications();
  if (!Notifications) return;

  if (!handlerSet) {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    handlerSet = true;
  }

  if (Platform.OS === "android") {
    // Must match the backend's android.notification.channelId ("default").
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: "#7b6ef0",
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;
  if (!granted && existing.canAskAgain) {
    const req = await Notifications.requestPermissionsAsync();
    granted = req.granted;
  }
  if (!granted) return;

  try {
    const token = (await Notifications.getDevicePushTokenAsync()).data;
    if (typeof token !== "string" || !token) return;
    currentToken = token;
    await registerDeviceToken(token, Platform.OS === "ios" ? "ios" : "android");
  } catch {
    // Best effort — a failed registration shouldn't disturb the app.
  }
}

/** Drop this device's token on logout so a signed-out phone stops receiving push. */
export async function unregisterForPush(): Promise<void> {
  if (!currentToken) return;
  try {
    await unregisterDeviceToken(currentToken);
  } catch {
    // ignore — token will be pruned server-side when it goes stale anyway
  }
  currentToken = null;
}

/** Subscribe to notification taps. Returns an unsubscribe fn; no-op in Expo Go. */
export function addNotificationTapListener(handler: (data: Record<string, unknown>) => void): () => void {
  const Notifications = loadNotifications();
  if (!Notifications) return () => undefined;
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    handler(response.notification.request.content.data as Record<string, unknown>);
  });
  return () => sub.remove();
}

/** Data of the notification that cold-started the app, if any. Null in Expo Go. */
export async function getInitialNotificationData(): Promise<Record<string, unknown> | null> {
  const Notifications = loadNotifications();
  if (!Notifications) return null;
  try {
    const response = await Notifications.getLastNotificationResponseAsync();
    return (response?.notification.request.content.data as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

/** Route a tapped notification to the right screen from its data payload. */
export function routeFromNotification(router: PushRouter, data: Record<string, unknown> | undefined): void {
  if (!data) return;
  const type = typeof data.type === "string" ? data.type : "";
  const id = (key: string) => (typeof data[key] === "string" ? (data[key] as string) : undefined);
  if (type === "job" && id("jobId")) {
    router.push({ pathname: "/jobs/[id]", params: { id: id("jobId")! } });
  } else if (type === "transfer" && id("transferId")) {
    router.push({ pathname: "/transfers/[id]", params: { id: id("transferId")! } });
  } else if (type === "vanstock" && id("requestId")) {
    router.push({ pathname: "/van-stock/[id]", params: { id: id("requestId")! } });
  }
}
