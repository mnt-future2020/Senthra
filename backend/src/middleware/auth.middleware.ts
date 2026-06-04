import type { RequestHandler } from "express";

import * as adminRepo from "../repositories/admin.repository.js";
import { ACCESS_COOKIE } from "../utils/cookies.js";
import { verifyAccessToken } from "../utils/jwt.js";

// Protects routes. Reads the access token from the httpOnly cookie first, then
// falls back to an `Authorization: Bearer` header. Also enforces server-side
// revocation via the admin's `tokenInvalidatedAt`.
export const requireAuth: RequestHandler = async (req, res, next) => {
  let token = req.cookies?.[ACCESS_COOKIE] as string | undefined;
  if (!token) {
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Bearer ")) token = header.slice(7);
  }
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
    const admin = await adminRepo.findById(payload.sub);
    if (!admin) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (admin.tokenInvalidatedAt && payload.iat) {
      const invalidatedSec = Math.floor(admin.tokenInvalidatedAt.getTime() / 1000);
      if (payload.iat < invalidatedSec) {
        res.status(401).json({ error: "Session expired. Please log in again." });
        return;
      }
    }
    req.adminId = admin.id;
    req.adminEmail = admin.email;
    next();
  } catch (err) {
    next(err);
  }
};
