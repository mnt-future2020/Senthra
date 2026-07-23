import { useEffect, useRef } from "react";
import { useRouter } from "expo-router";
import {
  addNotificationTapListener,
  getInitialNotificationData,
  registerForPush,
  routeFromNotification,
} from "./push";
import { useAuth } from "./auth";

/**
 * Registers this device for push once the engineer is signed in, and routes
 * notification taps to the right screen — both while the app is running and when
 * a tap cold-starts it. Mount once inside the authenticated tab shell. All the
 * native work is guarded inside ./push, so this is inert in Expo Go.
 */
export function usePushNotifications(): void {
  const router = useRouter();
  const { principal } = useAuth();
  const routed = useRef(false);

  useEffect(() => {
    if (principal?.type === "user") void registerForPush();
  }, [principal]);

  useEffect(() => {
    const unsubscribe = addNotificationTapListener((data) => routeFromNotification(router, data));
    // If a notification tap cold-started the app, route to it once.
    void getInitialNotificationData().then((data) => {
      if (data && !routed.current) {
        routed.current = true;
        routeFromNotification(router, data);
      }
    });
    return unsubscribe;
  }, [router]);
}
