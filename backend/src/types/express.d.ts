// Augments Express's Request so authenticated handlers can read the principal
// (and convenience id/email accessors) set by the requireAuth middleware.
import type { Principal } from "./principal.js";

export {};

declare global {
  namespace Express {
    interface Request {
      // The authenticated principal — admin or staff user.
      principal?: Principal;
      // Convenience accessors, each set only for the matching principal type.
      adminId?: string;
      adminEmail?: string;
      userId?: string;
      userEmail?: string;
      // The current session id (device) from the access token.
      sessionId?: string;
    }
  }
}
