import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";

import { env } from "../config/env.js";

// Which kind of account a session belongs to: the super-admin or a staff user.
// Both use the same token machinery; only the principal differs.
export type Actor = "admin" | "user";

export interface AccessTokenPayload extends JwtPayload {
  sub: string;
  type: "access";
  actor: Actor;
}

export interface RefreshTokenPayload extends JwtPayload {
  sub: string;
  type: "refresh";
  actor: Actor;
}

const accessExpiry = env.ACCESS_TOKEN_EXPIRY as SignOptions["expiresIn"];
const refreshExpiry = env.REFRESH_TOKEN_EXPIRY as SignOptions["expiresIn"];

// Tokens minted before the `actor` claim existed are treated as admin sessions.
function readActor(payload: JwtPayload): Actor {
  return payload.actor === "user" ? "user" : "admin";
}

// Short-lived token used for API access.
export function signAccessToken(sub: string, actor: Actor = "admin"): string {
  return jwt.sign({ sub, type: "access", actor }, env.JWT_SECRET, {
    expiresIn: accessExpiry,
  });
}

// Long-lived token used only to obtain new access tokens (separate secret).
export function signRefreshToken(sub: string, actor: Actor = "admin"): string {
  return jwt.sign({ sub, type: "refresh", actor }, env.REFRESH_SECRET, {
    expiresIn: refreshExpiry,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, env.JWT_SECRET);
  if (typeof payload === "string" || payload.type !== "access") {
    throw new Error("Not an access token");
  }
  return { ...payload, type: "access", actor: readActor(payload) } as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = jwt.verify(token, env.REFRESH_SECRET);
  if (typeof payload === "string" || payload.type !== "refresh") {
    throw new Error("Not a refresh token");
  }
  return { ...payload, type: "refresh", actor: readActor(payload) } as RefreshTokenPayload;
}
