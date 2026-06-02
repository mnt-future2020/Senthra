import { verifyAccessToken } from "../lib/jwt.js";
import { prisma } from "../lib/prisma.js";
import { ACCESS_COOKIE } from "../lib/cookies.js";

// Protects routes. Reads the access token from the httpOnly cookie first, then
// falls back to an `Authorization: Bearer` header. Also enforces server-side
// revocation via the admin's `tokenInvalidatedAt`.
export async function requireAuth(req, res, next) {
  let token = req.cookies?.[ACCESS_COOKIE];
  if (!token) {
    const header = req.headers.authorization || "";
    if (header.startsWith("Bearer ")) token = header.slice(7);
  }
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  try {
    const admin = await prisma.admin.findUnique({ where: { id: payload.sub } });
    if (!admin) return res.status(401).json({ error: "Unauthorized" });

    if (admin.tokenInvalidatedAt && payload.iat) {
      const invalidatedSec = Math.floor(admin.tokenInvalidatedAt.getTime() / 1000);
      if (payload.iat < invalidatedSec) {
        return res
          .status(401)
          .json({ error: "Session expired. Please log in again." });
      }
    }

    req.adminId = admin.id;
    next();
  } catch (err) {
    next(err);
  }
}
