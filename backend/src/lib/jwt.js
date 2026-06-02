import jwt from "jsonwebtoken";

const ACCESS_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY || "15m";
const REFRESH_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || "7d";

function accessSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("Missing JWT_SECRET in environment.");
  return s;
}

function refreshSecret() {
  const s = process.env.REFRESH_SECRET;
  if (!s) throw new Error("Missing REFRESH_SECRET in environment.");
  return s;
}

// Short-lived token used for API access.
export function signAccessToken(adminId) {
  return jwt.sign({ sub: adminId, type: "access" }, accessSecret(), {
    expiresIn: ACCESS_EXPIRY,
  });
}

// Long-lived token used only to obtain new access tokens (separate secret).
export function signRefreshToken(adminId) {
  return jwt.sign({ sub: adminId, type: "refresh" }, refreshSecret(), {
    expiresIn: REFRESH_EXPIRY,
  });
}

export function verifyAccessToken(token) {
  const payload = jwt.verify(token, accessSecret());
  if (payload.type !== "access") throw new Error("Not an access token");
  return payload;
}

export function verifyRefreshToken(token) {
  const payload = jwt.verify(token, refreshSecret());
  if (payload.type !== "refresh") throw new Error("Not a refresh token");
  return payload;
}
