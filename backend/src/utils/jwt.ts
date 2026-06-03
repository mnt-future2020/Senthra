import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";

import { env } from "../config/env.js";

export interface AccessTokenPayload extends JwtPayload {
  sub: string;
  type: "access";
}

export interface RefreshTokenPayload extends JwtPayload {
  sub: string;
  type: "refresh";
}

const accessExpiry = env.ACCESS_TOKEN_EXPIRY as SignOptions["expiresIn"];
const refreshExpiry = env.REFRESH_TOKEN_EXPIRY as SignOptions["expiresIn"];

// Short-lived token used for API access.
export function signAccessToken(adminId: string): string {
  return jwt.sign({ sub: adminId, type: "access" }, env.JWT_SECRET, {
    expiresIn: accessExpiry,
  });
}

// Long-lived token used only to obtain new access tokens (separate secret).
export function signRefreshToken(adminId: string): string {
  return jwt.sign({ sub: adminId, type: "refresh" }, env.REFRESH_SECRET, {
    expiresIn: refreshExpiry,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, env.JWT_SECRET);
  if (typeof payload === "string" || payload.type !== "access") {
    throw new Error("Not an access token");
  }
  return payload as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = jwt.verify(token, env.REFRESH_SECRET);
  if (typeof payload === "string" || payload.type !== "refresh") {
    throw new Error("Not a refresh token");
  }
  return payload as RefreshTokenPayload;
}
