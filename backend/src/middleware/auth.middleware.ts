import type { Request, RequestHandler } from "express";

import * as adminRepo from "#modules/auth/admin.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import { ACCESS_COOKIE } from "../utils/cookies.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { adminPrincipal, userPrincipal } from "../types/principal.js";

// A token is revoked when it was issued before the account's invalidation time
// (set on logout / password change).
function isRevoked(invalidatedAt: Date | null, issuedAtSec?: number): boolean {
  if (!invalidatedAt || !issuedAtSec) return false;
  return issuedAtSec < Math.floor(invalidatedAt.getTime() / 1000);
}

// Access token from the httpOnly cookie first, then an Authorization: Bearer header.
function readAccessToken(req: Request): string | undefined {
  const cookieToken = req.cookies?.[ACCESS_COOKIE] as string | undefined;
  if (cookieToken) return cookieToken;
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : undefined;
}

// Protects routes. Resolves the access token to either the super-admin or a staff
// user (per the token's `actor` claim), enforces server-side revocation, and
// attaches req.principal for downstream handlers.
export const requireAuth: RequestHandler = async (req, res, next) => {
  const token = readAccessToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  try {
    if (payload.actor === "user") {
      // findById already excludes soft-deleted users and includes the role.
      const user = await userRepo.findById(payload.sub);
      if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (user.status !== "active") {
        res.status(401).json({
          error: "Your account is not active. Contact an administrator.",
        });
        return;
      }
      if (isRevoked(user.tokenInvalidatedAt, payload.iat)) {
        res.status(401).json({ error: "Session expired. Please log in again." });
        return;
      }
      req.principal = userPrincipal(user);
      req.userId = user.id;
      req.userEmail = user.email;
      next();
      return;
    }

    const admin = await adminRepo.findById(payload.sub);
    if (!admin) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (isRevoked(admin.tokenInvalidatedAt, payload.iat)) {
      res.status(401).json({ error: "Session expired. Please log in again." });
      return;
    }
    req.principal = adminPrincipal(admin);
    req.adminId = admin.id;
    req.adminEmail = admin.email;
    next();
  } catch (err) {
    next(err);
  }
};

// Restrict a route to the super-admin account. Staff users get 403. This is the
// interim guard that keeps admin-only features (users, roles, settings, email
// templates) closed to staff until per-permission RBAC lands.
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.principal?.type !== "admin") {
    res.status(403).json({ error: "Administrator access required." });
    return;
  }
  next();
};
