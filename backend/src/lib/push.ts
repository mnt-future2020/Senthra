import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

import { env } from "../config/env.js";

// Firebase Cloud Messaging transport. Initialised once from the service-account
// env vars; if they're unset (e.g. local dev without push), it stays disabled and
// every send is a silent no-op so the app runs fine without Firebase configured.

let app: App | null = null;
let enabled = false;

function init(): void {
  if (app || getApps().length > 0) {
    app = getApps()[0] ?? app;
    enabled = !!app;
    return;
  }
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) return;
  app = initializeApp({
    credential: cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      // Stored with literal \n escapes in .env — restore real newlines for the PEM.
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
  enabled = true;
}
init();

export function pushEnabled(): boolean {
  return enabled;
}

export interface PushMessage {
  title: string;
  body: string;
  /** String map delivered to the app; drives tap-to-deep-link. FCM data must be strings. */
  data?: Record<string, string>;
}

// FCM error codes that mean a token is permanently dead and should be pruned.
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

/**
 * Send one notification to many device tokens in a single multicast. Returns the
 * subset of tokens that are permanently invalid so the caller can delete them.
 * Never throws — push failures must not break the domain action that triggered it.
 */
export async function sendToTokens(tokens: string[], msg: PushMessage): Promise<string[]> {
  if (!enabled || !app || tokens.length === 0) return [];
  try {
    const res = await getMessaging(app).sendEachForMulticast({
      tokens,
      notification: { title: msg.title, body: msg.body },
      data: msg.data ?? {},
      android: { priority: "high", notification: { channelId: "default", color: "#7b6ef0" } },
      apns: { payload: { aps: { sound: "default" } } },
    });
    const dead: string[] = [];
    res.responses.forEach((r, i) => {
      if (!r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code)) dead.push(tokens[i]!);
    });
    return dead;
  } catch {
    // Transport/credential failure — treat as no dead tokens, don't disturb the caller.
    return [];
  }
}
