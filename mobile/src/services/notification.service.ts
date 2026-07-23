import { api } from "../lib/api";

// Device push-token registration (Firebase FCM). The backend stores one row per
// device and fans notifications out to every device a user is signed in on.

export function registerDeviceToken(token: string, platform: "android" | "ios"): Promise<void> {
  return api("/notifications/device-token", { method: "POST", body: { token, platform } });
}

export function unregisterDeviceToken(token: string): Promise<void> {
  return api("/notifications/device-token", { method: "DELETE", body: { token } });
}
