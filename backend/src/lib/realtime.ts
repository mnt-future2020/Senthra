import type { Server as HttpServer } from "node:http";

import { parse as parseCookie } from "cookie";
import { Server as IOServer, type Socket } from "socket.io";

import * as sessionService from "#modules/auth/session.service.js";
import * as userRepo from "#modules/user/user.repository.js";
import { roleGrants } from "#modules/role/permissions.js";
import { env } from "../config/env.js";
import { ACCESS_COOKIE } from "../utils/cookies.js";
import { verifyAccessToken, type Actor } from "../utils/jwt.js";

// The singleton io instance. Created once in server.ts via initRealtime(); read
// everywhere else via emitToUser(). Null until the HTTP server is up.
let io: IOServer | null = null;

// Shared room for the office Jobs surface — every staff user who can VIEW jobs (or an
// admin) joins it, so job lifecycle events fan out to ALL watchers of the office list,
// not just the one engineer/creator. Permission-gated so non-jobs.view staff never
// receive job payloads over the socket.
export const OFFICE_JOBS_ROOM = "jobs:office";

// Identity resolved from the handshake, stashed on the socket for handlers.
interface SocketAuth {
  principalId: string; // token sub — also the room name
  actor: Actor;
  sid: string;
}
// socket.io's Socket.data is typed `any` by default; we narrow our usage.
type AuthedSocket = Socket & { data: { auth?: SocketAuth } };

// Read the SAME httpOnly access cookie the REST API uses, off the raw handshake
// header (cookie-parser does not run for websocket upgrades).
function readAccessToken(socket: Socket): string | undefined {
  const raw = socket.handshake.headers.cookie;
  if (!raw) return undefined;
  const cookies = parseCookie(raw);
  return cookies[ACCESS_COOKIE];
}

// Socket auth middleware — mirrors requireAuth: verify the access token, then
// enforce server-side session revocation (logout / password change / device cap).
async function authenticate(socket: Socket, next: (err?: Error) => void): Promise<void> {
  const token = readAccessToken(socket);
  if (!token) return next(new Error("Unauthorized"));

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return next(new Error("Invalid or expired token"));
  }

  try {
    const session = await sessionService.findActive(payload.sid);
    if (!session || !sessionService.sessionMatchesPrincipal(session, payload.actor, payload.sub)) {
      return next(new Error("Session expired"));
    }
    (socket as AuthedSocket).data.auth = {
      principalId: payload.sub,
      actor: payload.actor,
      sid: payload.sid,
    };
    next();
  } catch (err) {
    next(err instanceof Error ? err : new Error("Unauthorized"));
  }
}

// Create the io server bound to the existing HTTP server, mirroring the REST
// CORS policy (same origin allow-list + credentials so the cookie is sent).
export function initRealtime(httpServer: HttpServer): IOServer {
  io = new IOServer(httpServer, {
    cors: {
      origin: env.FRONTEND_URL,
      credentials: true,
    },
  });

  io.use(authenticate);

  io.on("connection", (socket) => {
    const auth = (socket as AuthedSocket).data.auth;
    if (!auth) return;
    // Every authenticated socket joins a room named after its principal id, so
    // emitToUser can target every device/tab of one user.
    void socket.join(auth.principalId);
    // Staff who can view jobs (admins always) also join the shared office room so the
    // Jobs list live-updates for every watcher. Permission load is one query per connect.
    void joinOfficeJobsRoom(socket, auth);
  });

  return io;
}

// Join the office Jobs room iff the principal may view jobs (admin → always; staff user →
// holds jobs.view / "*"). Best-effort: any failure just skips the room (REST still works).
async function joinOfficeJobsRoom(socket: Socket, auth: SocketAuth): Promise<void> {
  try {
    if (auth.actor === "customer") return; // customers never see internal jobs
    if (auth.actor === "admin") {
      await socket.join(OFFICE_JOBS_ROOM);
      return;
    }
    const user = await userRepo.findById(auth.principalId);
    if (user && roleGrants(user.role?.permissions ?? [], "jobs.view")) {
      await socket.join(OFFICE_JOBS_ROOM);
    }
  } catch {
    /* best-effort — a missed office join just means no live office refresh for this socket */
  }
}

// Emit an event to all live sockets of a single user (room === userId). No-op if
// realtime isn't initialised (e.g. unit tests).
export function emitToUser(userId: string, event: string, payload: unknown): void {
  io?.to(userId).emit(event, payload);
}

// Emit an event to every socket in a named room (e.g. OFFICE_JOBS_ROOM). No-op if
// realtime isn't initialised.
export function emitToRoom(room: string, event: string, payload: unknown): void {
  io?.to(room).emit(event, payload);
}
