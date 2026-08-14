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

// Shared room for the field-stock (van stock request) REVIEW surface — every user who can
// review/fulfil van stock requests (admin → always; a warehouse manager via
// van_stock_request.review) joins it, so a request's lifecycle events fan out to ALL
// reviewers, not just the requesting engineer. Warehouse managers do NOT hold jobs.view, so
// they were never in OFFICE_JOBS_ROOM — their VSR board never live-refreshed. This is the room
// VSR events belong in (they have no place in the jobs room). The event payload carries no
// privileged data (just {id, code, status, type}) and every client refetches through its OWN
// warehouse-scoped REST list, so a shared room can't leak another warehouse's request — a
// reviewer whose scope excludes the request just does one harmless no-op refetch.
export const VAN_STOCK_REVIEWERS_ROOM = "van_stock:reviewers";

// Shared room for the procurement surface — every user who can VIEW purchase orders joins it, so a
// PO's lifecycle events fan out to ALL watchers (the finance approver, the assigned PM, the
// warehouse expecting the goods). A PO is handled by several people in sequence — raised by one,
// approved by another, sent by the PM — so a detail page left open on one desk goes stale the
// moment someone else acts. Like the VSR room, the payload is a scope-agnostic "refetch" signal
// ({id, code, status}) and every client re-pulls through its OWN warehouse-scoped REST call, so a
// shared room can't leak another warehouse's order — a watcher outside the scope just does one
// harmless no-op refetch.
export const PURCHASE_ORDER_WATCHERS_ROOM = "purchase_orders:watchers";

// Shared room for the purchase-request surface, for the same reason as the PO room above: a PRF is
// raised by one person, approved/rejected by finance, then converted to a PO by procurement — so a
// request left open on one desk goes stale as soon as the next person in the chain acts. Same
// contract: the payload is a scope-agnostic refetch signal and every client re-pulls through its
// own scoped REST call, so the shared room leaks nothing.
export const PURCHASE_REQUEST_WATCHERS_ROOM = "purchase_requests:watchers";

// Shared room for the global ATTENTION signal (sidebar badges + the dashboard attention strip).
// Unlike the rooms above it is NOT permission-gated, and deliberately so: the rooms above are keyed
// on *.view, but pending work is gated by ACTION permissions (purchase_orders.approve, goods_in.create,
// jobs.kit_request.review …). A receiver who only holds goods_in.create belongs to none of the rooms
// above, so a gated attention room would silently never update their badge — the exact bug this
// system exists to prevent. Gating it would mean inventing one room per action permission.
// It is safe because the payload carries NO data at all — just an area name ("purchase_orders") as a
// debugging aid. Every client then refetches GET /attention, which filters the catalog against that
// user's OWN permissions and warehouse scope. A user who can act on nothing gets an empty payload, so
// the broadcast tells them nothing they couldn't already see. Customers are excluded (staff surface).
export const ATTENTION_ROOM = "attention:watchers";

// Identity resolved from the handshake, stashed on the socket for handlers.
interface SocketAuth {
  principalId: string; // token sub — also the room name
  actor: Actor;
  sid: string;
}
// socket.io's Socket.data is typed `any` by default; we narrow our usage.
type AuthedSocket = Socket & { data: { auth?: SocketAuth } };

// Read the SAME httpOnly access cookie the REST API uses, off the raw handshake
// header (cookie-parser does not run for websocket upgrades). Native clients (the
// mobile app) can't rely on a browser cookie jar, so — mirroring the REST
// middleware's cookie-first-then-Bearer order — fall back to the socket.io
// handshake `auth.token` payload, then an Authorization header.
function readAccessToken(socket: Socket): string | undefined {
  const raw = socket.handshake.headers.cookie;
  if (raw) {
    const fromCookie = parseCookie(raw)[ACCESS_COOKIE];
    if (fromCookie) return fromCookie;
  }
  const authToken = (socket.handshake.auth as Record<string, unknown> | undefined)?.token;
  if (typeof authToken === "string" && authToken) return authToken;
  const header = socket.handshake.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return undefined;
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
    // Jobs list live-updates for every watcher, and van-stock reviewers join their own room
    // so the field-stock board live-updates. One permission query loads the role for both.
    void joinScopedRooms(socket, auth);
  });

  return io;
}

// Join the permission-gated broadcast rooms this principal is entitled to, off a SINGLE role
// load (admin → all rooms; staff → per-permission). Mirrors the REST guards: OFFICE_JOBS_ROOM =
// jobs.view; VAN_STOCK_REVIEWERS_ROOM = van_stock_request.review (same gate as VSR's isReviewer,
// so a warehouse manager — who lacks jobs.view — still gets a live field-stock board);
// PURCHASE_ORDER_WATCHERS_ROOM = purchase_orders.view and PURCHASE_REQUEST_WATCHERS_ROOM =
// purchase_requests.view (the same gates their REST routes use).
// Best-effort: any failure just skips the rooms (REST still works, the surface just won't
// live-refresh).
async function joinScopedRooms(socket: Socket, auth: SocketAuth): Promise<void> {
  try {
    if (auth.actor === "customer") return; // customers never see internal staff surfaces
    // Every staff socket watches the attention signal — see ATTENTION_ROOM: it carries no data, and
    // the per-user filtering happens in GET /attention.
    void socket.join(ATTENTION_ROOM);
    if (auth.actor === "admin") {
      await Promise.all([
        Promise.resolve(socket.join(OFFICE_JOBS_ROOM)),
        Promise.resolve(socket.join(VAN_STOCK_REVIEWERS_ROOM)),
        Promise.resolve(socket.join(PURCHASE_ORDER_WATCHERS_ROOM)),
        Promise.resolve(socket.join(PURCHASE_REQUEST_WATCHERS_ROOM)),
      ]);
      return;
    }
    const user = await userRepo.findById(auth.principalId);
    const perms = user?.role?.permissions ?? [];
    const joins: Promise<unknown>[] = [];
    if (roleGrants(perms, "jobs.view")) joins.push(Promise.resolve(socket.join(OFFICE_JOBS_ROOM)));
    if (roleGrants(perms, "van_stock_request.review")) joins.push(Promise.resolve(socket.join(VAN_STOCK_REVIEWERS_ROOM)));
    if (roleGrants(perms, "purchase_orders.view")) joins.push(Promise.resolve(socket.join(PURCHASE_ORDER_WATCHERS_ROOM)));
    if (roleGrants(perms, "purchase_requests.view")) joins.push(Promise.resolve(socket.join(PURCHASE_REQUEST_WATCHERS_ROOM)));
    await Promise.all(joins);
  } catch {
    /* best-effort — a missed room join just means no live refresh for that surface on this socket */
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

// Tell every staff client "some pending-work count may have moved — refetch your own attention".
// Called from the SAME wrappers that already emit each module's own event, so a workflow transition
// refreshes both the module surface and the global badges in one step. `area` is a hint for logging
// and debugging only; the client always refetches the whole (permission-filtered) attention payload,
// so no privileged data ever rides the broadcast.
export function emitAttentionChanged(area: string): void {
  io?.to(ATTENTION_ROOM).emit("attention:changed", { area });
}
