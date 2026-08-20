// ── Attention service — ONE computation behind every badge in the product ──────────────────────
//
// The sidebar badges, the dashboard attention strip and the module tab counts all read this. There is
// no second implementation and no frontend arithmetic: if a number appears twice in the UI it came
// from here twice.
//
// Flow: catalog → drop the items this actor may not see → run only the sources that still have a
// reason to run → merge → drop any key the actor can't see (a source may produce several keys under
// different permissions) → roll up per sidebar row.
//
// Failure is per-source, never global (the dashboard's `settle` contract): a source that throws puts
// its id in `errors` and its keys simply don't appear. A broken count can never blank the sidebar.

import { principalGrants } from "../../types/principal.js";
import type { Principal } from "../../types/principal.js";
import { warehouseScopeFilter } from "../../lib/warehouse-access.js";
import { startOfDayIn } from "../../utils/filter-date.js";
import { getCompanyTimezone } from "#modules/settings/settings.service.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import {
  ATTENTION_ENTITY_SOURCES,
  ATTENTION_ITEMS,
  ATTENTION_SOURCES,
  type AttentionCtx,
  type AttentionDimension,
  type AttentionTone,
} from "./attention.registry.js";

export interface AttentionItem {
  key: string;
  label: string;
  count: number;
  tone: AttentionTone;
  nav: string;
  /**
   * Absent when this count has no single screen that shows it — see the registry's `href` note. The UI
   * renders those as a plain number, never as a link, because the honest alternative (pointing at the
   * module list) navigates somewhere that does not contain the rows the number counted.
   */
  href?: string;
  /**
   * Set when this key's rows are a subset of another key's — see the registry's `subsetOf`.
   *
   * Emitted to the client because any surface that ADDS UP items has to skip it for the same reason
   * the nav rollup does. It is display wiring, not a permission hint, so unlike `perms` it is safe to
   * send.
   */
  subsetOf?: string;
}

export interface AttentionNavRollup {
  /** total actionable items behind this sidebar row */
  count: number;
  /** the most severe tone among the row's items — what colour the badge takes */
  tone: AttentionTone;
}

export interface AttentionSummary {
  /** only keys the actor may see AND whose count is > 0 — a badge never renders a zero */
  items: AttentionItem[];
  /** sidebar-row rollup, keyed by nav href */
  byNav: Record<string, AttentionNavRollup>;
  /** total across every visible item */
  total: number;
  /** source ids that were permitted but threw (their keys are absent, not zero) */
  errors: string[];
  calculatedAt: string;
}

const TONE_RANK: Record<AttentionTone, number> = { critical: 0, attention: 1, info: 2 };
const worst = (a: AttentionTone, b: AttentionTone): AttentionTone => (TONE_RANK[a] <= TONE_RANK[b] ? a : b);

// A short cache, deliberately. It exists to absorb the mount BURST — sidebar + dashboard strip + a
// module tab header all render together on first paint and would otherwise each recompute the same
// numbers. It is NOT a staleness budget: socket-driven refetches pass `fresh` and skip it entirely,
// so a live update is never delayed by the cache.
const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { at: number; value: AttentionSummary }>();
/** Same burst window for the per-entity rollups — see getEntityAttention. */
const entityCache = new Map<string, { at: number; value: Record<string, AttentionEntityRow> }>();

/** Exported for tests and for any write path that wants the next read to be live. */
export function invalidateAttention(): void {
  cache.clear();
  entityCache.clear();
}

/** Cache identity: WHO is asking plus WHAT they can reach — two users with the same access share one
 *  computation, and nobody can ever read another scope's numbers out of the cache. */
function cacheKey(actor: Principal, scope: string[] | undefined): string {
  const actorId = "id" in actor && actor.id ? actor.id : "anon";
  return `${actorId}|${scope === undefined ? "*" : [...scope].sort().join(",")}`;
}

export async function getAttention(actor: Principal, opts: { fresh?: boolean; now?: Date } = {}): Promise<AttentionSummary> {
  const can = (key: string) => principalGrants(actor, key);
  const scope = warehouseScopeFilter(actor);

  // Mirrors getReorderSummary: the sorted warehouse-id set is part of the key.
  const actorId = "id" in actor && actor.id ? actor.id : "anon";
  const key = cacheKey(actor, scope);
  const now = opts.now ?? new Date();
  if (!opts.fresh) {
    const hit = cache.get(key);
    if (hit && now.getTime() - hit.at < CACHE_TTL_MS) return hit.value;
  }

  // 1) Which items may this actor see at all?
  const visible = ATTENTION_ITEMS.filter((i) => i.perms.some(can));
  const visibleKeys = new Set(visible.map((i) => i.key));
  if (visible.length === 0) {
    const empty: AttentionSummary = { items: [], byNav: {}, total: 0, errors: [], calculatedAt: now.toISOString() };
    cache.set(key, { at: now.getTime(), value: empty });
    return empty;
  }

  // 2) Run only the sources that still produce at least one visible key. A warehouse manager runs a
  //    handful of counts, not the whole catalog.
  const sources = ATTENTION_SOURCES.filter((s) => s.keys.some((k) => visibleKeys.has(k)));
  const timeZone = await getCompanyTimezone();
  const ctx: AttentionCtx = {
    actor,
    scope,
    // Only meaningful for the PO pm_review queue: a user who can reassign PMs sees every pending
    // send, everyone else sees only the ones addressed to them. Same rule as the dashboard worklist.
    userId: can("purchase_orders.assign_pm") ? undefined : actorId,
    now,
    dayStart: startOfDayIn(timeZone, now),
    timeZone,
  };

  const settled = await Promise.allSettled(sources.map((s) => s.run(ctx)));
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") Object.assign(counts, r.value);
    else {
      errors.push(sources[i].id);
      // Logged, never thrown — one bad count degrades to "absent", it does not blank the sidebar.
      console.error(`[attention] source "${sources[i].id}" failed:`, r.reason);
    }
  });

  // 3) Emit only visible keys with real work. A source may legitimately produce keys the actor can't
  //    see (one query, several permissions) — this is the gate that stops that leaking.
  const withWork = visible
    .map((meta) => ({ ...meta, count: counts[meta.key] ?? 0 }))
    .filter((i) => i.count > 0)
    .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.count - a.count);

  // 4) Warehouse-floor queues become a real deep link when the actor can reach exactly ONE warehouse:
  //    the aggregate and the warehouse are then the same thing, so the ambiguity that costs the others
  //    their href doesn't exist. This is the common case for floor staff. Looked up ONCE per response,
  //    and only if at least one such item survived — an unscoped admin pays nothing.
  const code =
    scope?.length === 1 && withWork.some((i) => i.warehouseQuery)
      ? await warehouseRepo.findCodeById(scope[0]).catch(() => null)
      : null;
  //    `perms`, `hrefPerms` and `warehouseQuery` are destructured OFF here rather than spread through:
  //    they are catalog wiring, and the permission lists in particular are what these counts are gated
  //    on, which the client has no use for and should not be handed.
  //
  //    A LINK IS ONLY EMITTED IF THE ACTOR CAN OPEN IT. Seeing a queue and being able to reach the
  //    screen that lists it are separate grants (see `hrefPerms`), so a chip whose destination would
  //    refuse this actor loses its href and renders as a plain number — the same treatment the catalog
  //    already gives a count with no single screen behind it. The count itself is untouched: it is
  //    their work either way. The warehouse deep link below is held to the same rule against
  //    `warehouse.view`, which is what its detail page is gated on.
  const items: AttentionItem[] = withWork.map(({ warehouseQuery, perms: _perms, hrefPerms, href, ...meta }) => {
    const reachable =
      href !== undefined
        ? !hrefPerms || hrefPerms.some(can)
          ? href
          : undefined
        : warehouseQuery && code && can("warehouse.view")
          ? `/dashboard/warehouses/${encodeURIComponent(code)}?${warehouseQuery}`
          : undefined;
    return reachable ? { ...meta, href: reachable } : meta;
  });

  // 5) Roll up per sidebar row. A key declared as a SUBSET of another (see `subsetOf`) contributes its
  //    TONE but not its COUNT: its rows are already inside the parent's number, and adding both would
  //    report more work than exists. Every other pair of keys is disjoint, so the rest is a plain sum.
  //    `subsetOf` is read from the catalog, not from `items` — a parent whose count is zero is absent
  //    from the payload, and the subset must still not be double-added on the strength of that.
  //
  //    It stands down ONLY when the parent is permitted for THIS actor. The two keys can be gated on
  //    different permissions — "Deliveries overdue" is `purchase_orders.view` while its parent
  //    "Deliveries to receive" is `goods_in.create` — so a project manager sees the subset and not the
  //    parent. Subtracting it unconditionally would leave that row reporting LESS work than exists,
  //    which is the same defect as double counting, pointing the other way.
  const byNav: Record<string, AttentionNavRollup> = {};
  const absorbed = (i: { subsetOf?: string }) => Boolean(i.subsetOf && visibleKeys.has(i.subsetOf));
  const counted = withWork.filter((i) => !absorbed(i));
  for (const i of withWork) {
    const add = absorbed(i) ? 0 : i.count;
    const row = byNav[i.nav];
    if (row) {
      row.count += add;
      row.tone = worst(row.tone, i.tone);
    } else {
      byNav[i.nav] = { count: add, tone: i.tone };
    }
  }
  // A row whose only work is a subset of a parent that is itself zero would otherwise render a badge
  // of 0. That cannot happen while a subset implies a non-empty parent, but the guard costs nothing
  // and a zero badge is precisely the thing this system promises never to show.
  for (const [nav, row] of Object.entries(byNav)) if (row.count === 0) delete byNav[nav];

  const value: AttentionSummary = {
    items,
    byNav,
    total: counted.reduce((n, i) => n + i.count, 0),
    errors,
    calculatedAt: now.toISOString(),
  };
  // Drop expired entries so a long-lived process can't accumulate keys for users who logged out.
  for (const [k, v] of cache) if (now.getTime() - v.at >= CACHE_TTL_MS) cache.delete(k);
  cache.set(key, { at: now.getTime(), value });
  return value;
}

// ── Per-entity rollups ─────────────────────────────────────────────────────────────────────────

export interface AttentionEntityRow {
  /** total actionable items at this entity */
  count: number;
  /** most severe tone among them — the colour the row's pill takes */
  tone: AttentionTone;
  /** key → count, so a surface can show ONE queue (a warehouse tab) instead of the row total */
  keys: Record<string, number>;
}

/**
 * "Where is the work?", answered per warehouse or per customer.
 *
 * This is the navigation for every count the catalog gives no `href`: those queues are worked on one
 * entity's own page, so the aggregate is not a screen anyone can open, but each entity's share is.
 * The Warehouses and Customers lists render it on the row; the warehouse detail page reads `keys` to
 * put a count on the tab that owns each queue.
 *
 * Same permission rule as the badges — an entity's row only ever contains keys this actor may see —
 * and the same failure rule: a source that throws contributes nothing rather than failing the call, so
 * one broken count cannot blank a whole list's counts.
 *
 * NOT a decomposition of the sidebar badge: work spanning two warehouses is counted at both. See the
 * note above ATTENTION_ENTITY_SOURCES.
 */
export async function getEntityAttention(
  actor: Principal,
  dimension: AttentionDimension,
  opts: { fresh?: boolean; now?: Date } = {},
): Promise<Record<string, AttentionEntityRow>> {
  const can = (key: string) => principalGrants(actor, key);
  const visibleKeys = new Set(ATTENTION_ITEMS.filter((i) => i.perms.some(can)).map((i) => i.key));
  const sources = ATTENTION_ENTITY_SOURCES.filter(
    (s) => s.dimension === dimension && s.keys.some((k) => visibleKeys.has(k)),
  );
  if (sources.length === 0) return {};

  const now = opts.now ?? new Date();
  const scope = warehouseScopeFilter(actor);
  const key = `${dimension}|${cacheKey(actor, scope)}`;
  if (!opts.fresh) {
    const hit = entityCache.get(key);
    if (hit && now.getTime() - hit.at < CACHE_TTL_MS) return hit.value;
  }

  const timeZone = await getCompanyTimezone();
  // `userId` is built the same way as on the badge path even though no entity source reads it yet:
  // undefined means "sees every queue, not just the ones addressed to me", so a future source that
  // trusted the field would silently widen rather than fail.
  const ctx: AttentionCtx = {
    actor,
    scope,
    userId: can("purchase_orders.assign_pm") ? undefined : ("id" in actor && actor.id) || undefined,
    now,
    dayStart: startOfDayIn(timeZone, now),
    timeZone,
  };

  const toneOf = new Map(ATTENTION_ITEMS.map((i) => [i.key, i.tone]));
  const out: Record<string, AttentionEntityRow> = {};
  const settled = await Promise.allSettled(sources.map((s) => s.run(ctx)));
  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`[attention] entity source "${sources[i].id}" failed:`, r.reason);
      return;
    }
    for (const [entityId, counts] of Object.entries(r.value)) {
      for (const [key, count] of Object.entries(counts)) {
        // The gate that stops a leak: a source may produce keys under several permissions, and this
        // actor may only hold one of them.
        if (!visibleKeys.has(key) || count <= 0) continue;
        const tone = toneOf.get(key) ?? "info";
        const row = (out[entityId] ??= { count: 0, tone, keys: {} });
        row.count += count;
        row.keys[key] = (row.keys[key] ?? 0) + count;
        row.tone = worst(row.tone, tone);
      }
    }
  });
  for (const [k, v] of entityCache) if (now.getTime() - v.at >= CACHE_TTL_MS) entityCache.delete(k);
  entityCache.set(key, { at: now.getTime(), value: out });
  return out;
}
