import * as deviceTokenRepo from "./deviceToken.repository.js";
import { sendToTokens, type PushMessage } from "../../lib/push.js";

// Register / unregister a device for the signed-in user.
export async function registerToken(userId: string, token: string, platform: string): Promise<void> {
  await deviceTokenRepo.upsert(token, userId, platform);
}

export async function unregisterToken(token: string): Promise<void> {
  await deviceTokenRepo.remove(token);
}

/**
 * Drop every device belonging to a user who can no longer sign in (deleted / inactive / suspended).
 *
 * Called by the user service when it puts an account into one of those states. Deliberately NOT
 * called anywhere else: a token registered to an account that can still authenticate is a live
 * token, and removing it would silently stop that engineer's notifications.
 */
export async function clearDevicesForUser(userId: string): Promise<number> {
  const { count } = await deviceTokenRepo.removeAllForUser(userId);
  return count;
}

/**
 * Fire-and-forget push to every device a user is signed in on. Deliberately does
 * NOT return a promise the caller must await — domain services call it right next
 * to their socket emit, so a slow or failed push must never add latency to (or roll
 * back) the action that triggered it. Dead tokens are pruned as a side effect.
 */
export function notify(userId: string, msg: PushMessage): void {
  void (async () => {
    try {
      const tokens = await deviceTokenRepo.tokensForUser(userId);
      if (tokens.length === 0) return;
      const dead = await sendToTokens(tokens, msg);
      if (dead.length > 0) await deviceTokenRepo.removeMany(dead);
    } catch {
      // Best-effort — never surface push failures into the domain flow.
    }
  })();
}
