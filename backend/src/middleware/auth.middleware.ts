import type { Request, RequestHandler } from "express";

import * as adminRepo from "#modules/auth/admin.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as customerRepo from "#modules/customer/customer.repository.js";
import * as sessionService from "#modules/auth/session.service.js";
import { roleGrants } from "#modules/role/permissions.js";
import { ACCESS_COOKIE } from "../utils/cookies.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { adminPrincipal, customerPrincipal, userPrincipal } from "../types/principal.js";

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
    // The session must still exist — it doesn't after logout, a password change,
    // or eviction by the 2-device cap, so this is where those take effect.
    if (!(await sessionService.isActive(payload.sid))) {
      res.status(401).json({ error: "Session expired. Please log in again." });
      return;
    }
    req.sessionId = payload.sid;

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
      req.principal = userPrincipal(user);
      req.userId = user.id;
      req.userEmail = user.email;
      next();
      return;
    }

    if (payload.actor === "customer") {
      // findById excludes soft-deleted customers.
      const customer = await customerRepo.findById(payload.sub);
      if (!customer) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (customer.status !== "active") {
        res.status(401).json({
          error: "Your account is not active. Contact your administrator.",
        });
        return;
      }
      req.principal = customerPrincipal(customer);
      req.customerId = customer.id;
      req.customerEmail = customer.email;
      next();
      return;
    }

    const admin = await adminRepo.findById(payload.sub);
    if (!admin) {
      res.status(401).json({ error: "Unauthorized" });
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

// Restrict a route to the super-admin account. Staff users get 403. Used for the
// most sensitive surfaces (role + permission configuration, the admin's own
// account) which are never delegated.
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.principal?.type !== "admin") {
    res.status(403).json({ error: "Administrator access required." });
    return;
  }
  next();
};

// Restrict a route to a customer principal (the read-only portal surface). Staff
// and the admin get 403 — the customer portal is exclusively for customers. A
// customer who hasn't completed the forced first-login password set is walled off
// the portal data until they do (mirrors the staff requirePermission wall), so a
// temp-password session can't read anything but the password-set endpoint.
export const requireCustomer: RequestHandler = (req, res, next) => {
  const principal = req.principal;
  if (principal?.type !== "customer") {
    res.status(403).json({ error: "Customer access required." });
    return;
  }
  if (principal.mustResetPassword) {
    res.status(403).json({ error: "Set your password before continuing." });
    return;
  }
  next();
};

// Restrict a route to principals holding a specific permission. The super-admin
// account always passes; a staff user passes if their role grants it (or "*").
// A customer principal carries only its fixed read-only set, so it fails any
// staff/admin permission here — defence in depth on top of the route separation.
export function requirePermission(permission: string): RequestHandler {
  return (req, res, next) => {
    const principal = req.principal;
    if (!principal) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (principal.type === "admin") {
      next();
      return;
    }
    // A staff user who hasn't completed the forced first-login password set is
    // walled off from every feature surface until they do. This makes the reset a
    // real server-side boundary, not just the portal's UI funnel — a direct API
    // call with the temp-password session can't reach anything permissioned.
    if (principal.mustResetPassword) {
      res.status(403).json({ error: "Set your password before continuing." });
      return;
    }
    if (roleGrants(principal.permissions, permission)) {
      next();
      return;
    }
    res.status(403).json({ error: "You don't have permission to do that." });
  };
}

// Restrict a route to principals holding ANY ONE of the given permissions. Used
// where a surface is reachable from more than one capability — e.g. the roles
// list, needed both by role-managers (roles.view) and by the user form's role
// picker (users.create / users.edit). The super-admin always passes.
export function requireAnyPermission(...permissions: string[]): RequestHandler {
  return (req, res, next) => {
    const principal = req.principal;
    if (!principal) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (principal.type === "admin") {
      next();
      return;
    }
    if (principal.mustResetPassword) {
      res.status(403).json({ error: "Set your password before continuing." });
      return;
    }
    if (permissions.some((p) => roleGrants(principal.permissions, p))) {
      next();
      return;
    }
    res.status(403).json({ error: "You don't have permission to do that." });
  };
}
