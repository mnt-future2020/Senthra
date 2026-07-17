"use client";

import * as React from "react";
import { Camera, Check, Loader2, PackageCheck, Trash2, X } from "lucide-react";

import * as vanStockSvc from "@/services/vanStockRequest.service";
import type { FulfilEntryPayload, VanStockRequest, WarehouseAvailability } from "@/services/vanStockRequest.service";
import { listWarehouseOptions, type WarehouseOption } from "@/services/warehouse.service";
import { subscribe } from "@/lib/socket";
import { useDashboard } from "@/hooks/useDashboard";
import { CopyableCode } from "@/components/ui/CopyableCode";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { dangerBtn, inputCls, labelCls, primaryBtn, secondaryBtn } from "@/components/ui/styles";
import { fmtDateTime } from "@/components/dashboard/portal/portalUi";
import { ScannerInput } from "@/components/dashboard/goods-management/ScannerInput";
import { VanStockStatusChip } from "@/components/dashboard/engineer/EngineerVanStock";
import type { Msg } from "@/components/ui/types";

// Review + fulfil panel for one van stock request. Three zones by state:
//   info (always) · review (pending restock: warehouse + trims + approve/decline)
//   fulfil (restock approved/partial · return pending/partial: scan → entries → post; close short).

// ONE row per scanned request line. A RETURN splits that line across good + damaged in a single posting
// (5 back = 3 good + 2 damaged), mirroring goods-management/JobScanPanel's ScanLine — the backend sums
// entries per lineId against the line's remaining qty, so the split fans out to two payload entries at
// post time and still closes the line at 5. A RESTOCK only ever issues good stock, so `damagedQty` stays
// 0 there and only the single qty box renders.
interface FulfilRow {
  lineId: string;
  itemName: string;
  scannedCode: string;
  goodQty: number;
  damagedQty: number; // returns only
  remainingQty: number;
  available: number | null;
  damagePhotoDataUrl?: string; // data URI — local preview only, never sent
  damagePhotoUrl?: string; // Cloudinary URL — what the posting carries
  damageReason?: string;
  uploading?: boolean;
}

// The MOST this row may post IN TOTAL (good + damaged): what the request still owes, capped by what
// physically exists when we know it (the shelf on a restock, the van on a return; null = unknown, so
// don't cap on it). The scan handler and every qty box MUST share this — if they disagree, one of them
// lets the user build a line the server will reject at Post. Advisory only: the server re-checks both
// authoritatively inside the tx.
const entryCap = (e: { remainingQty: number; available: number | null }): number =>
  Math.max(1, Math.min(e.remainingQty, e.available ?? e.remainingQty));

// Total being moved for a row = good + damaged (GM's returnTotal).
const rowTotal = (e: FulfilRow): number => e.goodQty + e.damagedQty;

// Loading placeholder for the modal body — mirrors the loaded layout (status chips → reason card →
// lines table) so the modal doesn't jump when the request arrives.
function DetailSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-24 rounded-full" />
        <Skeleton className="h-5 w-20 rounded-full" />
        <Skeleton className="ml-auto h-3 w-28" />
      </div>
      <Skeleton className="h-16 w-full rounded-xl" />
      <div className="overflow-hidden rounded-xl border border-[var(--border)]">
        <div className="flex gap-3 border-b border-[var(--border)] px-3 py-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="ml-auto h-3 w-16" />
          <Skeleton className="h-3 w-16" />
        </div>
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-3 last:border-0">
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="ml-auto h-4 w-10" />
            <Skeleton className="h-4 w-10" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function VanRequestDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { pushToast } = useDashboard();
  const [req, setReq] = React.useState<VanStockRequest | null>(null);
  const [msg, setMsg] = React.useState<Msg>(null);
  const [busy, setBusy] = React.useState(false);

  // Review state (pending restock)
  const [warehouses, setWarehouses] = React.useState<WarehouseOption[]>([]);
  const [warehouseId, setWarehouseId] = React.useState("");
  const [trims, setTrims] = React.useState<Record<string, number>>({});
  const [sources, setSources] = React.useState<Record<string, string>>({}); // lineId → sourceWarehouseId
  const [availability, setAvailability] = React.useState<WarehouseAvailability[]>([]);
  const [decisionNote, setDecisionNote] = React.useState("");
  const [declineOpen, setDeclineOpen] = React.useState(false);
  const [declineNote, setDeclineNote] = React.useState("");

  // Fulfil state. The scan handler reads the cart AFTER its lookup resolves — by then its closure's
  // copy of `entries` may be a render behind, so it reads `entriesRef` instead (see onScan). Every write
  // goes through this `setEntries`, which keeps the ref in lockstep with the state: syncing the ref in
  // an effect would leave it stale between two scans that land inside the same commit.
  const [entries, setEntriesState] = React.useState<FulfilRow[]>([]);
  const entriesRef = React.useRef<FulfilRow[]>([]);
  const setEntries = React.useCallback((next: FulfilRow[] | ((rows: FulfilRow[]) => FulfilRow[])) => {
    const rows = typeof next === "function" ? (next as (rows: FulfilRow[]) => FulfilRow[])(entriesRef.current) : next;
    entriesRef.current = rows;
    setEntriesState(rows);
  }, []);
  const [scanning, setScanning] = React.useState(false); // a lookup is in flight — drops scan-gun double-fires
  const [closeShortOpen, setCloseShortOpen] = React.useState(false);
  const [closeShortNote, setCloseShortNote] = React.useState("");

  // Duplicate context — the engineer's OTHER open requests.
  const [otherOpen, setOtherOpen] = React.useState<string[]>([]);

  // Monotonic fetch token: `load()` and the socket's background refresh both write `req` for the same
  // id, so two responses can be in flight at once (post → load(), while the post's own socket event
  // fires). Without ordering, an earlier response landing last reverts the view to pre-post state —
  // showing already-issued lines as still outstanding. Every write checks it owns the latest request.
  const fetchSeq = React.useRef(0);

  const load = React.useCallback(() => {
    const seq = ++fetchSeq.current;
    vanStockSvc
      .getVanStockRequest(id)
      .then((r) => {
        if (seq !== fetchSeq.current) return; // superseded by a newer fetch
        setReq(r);
        setWarehouseId((prev) => prev || r.warehouseId || r.preferredWarehouseId || "");
        setEntries([]);
      })
      .catch((err) => {
        if (seq !== fetchSeq.current) return;
        setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load the request." });
      });
  }, [id, setEntries]); // setEntries is stable (useCallback, no deps) — this never re-triggers the load

  React.useEffect(() => load(), [load]);

  // `busyRef` is the SYNCHRONOUS mirror of `busy`, and it has two jobs:
  //  1. the socket handler reads it to skip a background refresh while our own action is in flight
  //     (that path reloads itself) without re-subscribing every render;
  //  2. the mutating handlers (onApprove/onPost) use it as a re-entrancy latch — `disabled={busy}`
  //     can't stop two clicks batched into ONE React commit, because setBusy only lands on the next
  //     render, so both reads would see false.
  // Writes go through `setBusyBoth`, which flips the ref FIRST (synchronously, so a second click in the
  // same commit sees it) and then the state. No effect syncs the ref back from `busy`: that would race
  // the latch — a re-render between the latch and setBusyBoth(true) would reset the ref to the stale false
  // and reopen the double-fire window this closes.
  const busyRef = React.useRef(busy);
  const setBusyBoth = React.useCallback((v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  }, []);
  React.useEffect(() => {
    const onEvent = () => {
      if (busyRef.current) return;
      const seq = ++fetchSeq.current;
      vanStockSvc
        .getVanStockRequest(id)
        .then((r) => {
          if (seq !== fetchSeq.current) return; // a newer load()/event won — don't rewind `req`
          setReq(r);
        })
        .catch(() => {}); // background refresh — a transient failure just leaves the last-known state
    };
    return subscribe(["van_stock_request:updated"], onEvent);
  }, [id]);
  React.useEffect(() => {
    listWarehouseOptions().then(setWarehouses).catch(() => setWarehouses([]));
  }, []);
  // Per-warehouse availability for the review-zone source pickers. Each line's source defaults to the
  // primary lazily at read time (`sources[l.id] ?? warehouseId`), so no eager seed is needed here —
  // the primary-warehouse select keeps un-touched lines in sync via its onChange.
  React.useEffect(() => {
    if (!req || req.status !== "pending" || req.type !== "restock") return;
    const ids = req.lines.map((l) => l.irmItemId);
    vanStockSvc.getVanStockAvailability(ids).then(setAvailability).catch(() => setAvailability([]));
  }, [req]);
  const shelfOf = React.useCallback(
    (irmItemId: string, whId: string): number | null => {
      const w = availability.find((a) => a.warehouseId === whId);
      if (!w) return null;
      return w.items.find((i) => i.irmItemId === irmItemId)?.quantityOnHand ?? 0;
    },
    [availability],
  );
  // Per-line source-warehouse options, from the AVAILABILITY feed (ALL warehouses, unscoped — NOT the
  // reviewer-scoped `warehouses` list, since re-sourcing is a work order to any warehouse holding the
  // item). We show only warehouses that actually HOLD this item (on-hand > 0), PLUS the primary/current
  // source (even at 0) so the dropdown's default value always has a matching option and stays visible.
  // Falls back to the scoped `warehouses` only while availability hasn't loaded (dropdown never blank).
  const sourceOptionsFor = React.useCallback(
    (irmItemId: string, keepId: string): Array<{ id: string; name: string; code: string | null }> => {
      if (availability.length === 0) return warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }));
      return availability
        .filter((a) => {
          const onHand = a.items.find((i) => i.irmItemId === irmItemId)?.quantityOnHand ?? 0;
          return onHand > 0 || a.warehouseId === keepId; // in-stock warehouses + always keep the current/primary
        })
        .map((a) => ({ id: a.warehouseId, name: a.warehouseName, code: a.warehouseCode }));
    },
    [availability, warehouses],
  );
  // Is this item on ANY warehouse's shelf right now? Drives the shortfall hint's wording: with stock
  // somewhere, "pick another" is real advice; with none anywhere it's a wild goose chase — the only
  // move left is to exclude the line (qty 0), which is what the Approve hint already says. Mirrors
  // sourceOptionsFor's `onHand > 0` rule, so "stocked somewhere" and "the dropdown has another option"
  // can never disagree. Unknown (feed not loaded) ⇒ true, so we never claim "nowhere" on missing data.
  const stockedSomewhere = React.useCallback(
    (irmItemId: string): boolean => {
      if (availability.length === 0) return true; // unknown — don't assert nowhere
      return availability.some((a) => (a.items.find((i) => i.irmItemId === irmItemId)?.quantityOnHand ?? 0) > 0);
    },
    [availability],
  );
  React.useEffect(() => {
    if (!req || req.status !== "pending") return;
    // Cheap client-side duplicate context: other open requests from the same engineer.
    Promise.all([
      vanStockSvc.listVanStockRequests({ status: "pending", pageSize: 100 }),
      vanStockSvc.listVanStockRequests({ status: "approved", pageSize: 100 }),
      vanStockSvc.listVanStockRequests({ status: "partially_fulfilled", pageSize: 100 }),
    ])
      .then((pages) => {
        const codes = pages
          .flatMap((p) => p.requests)
          .filter((r) => r.engineerId === req.engineerId && r.id !== req.id)
          .map((r) => r.code);
        setOtherOpen([...new Set(codes)]);
      })
      .catch(() => setOtherOpen([]));
  }, [req]);

  const isReviewZone = req?.status === "pending" && req.type === "restock";
  const isFulfilZone =
    !!req &&
    ((req.type === "restock" && (req.status === "approved" || req.status === "partially_fulfilled")) ||
      (req.type === "return" && (req.status === "pending" || req.status === "partially_fulfilled")));
  const canDecline = req?.status === "pending";

  // Hard-block: Approve is disabled when a line's chosen source is KNOWN to hold < approve-qty. This
  // is an ADVISORY snapshot — the backend re-checks availability authoritatively at approve, and the
  // zero-floor guard is the final backstop. So we must NOT block on unknown/unloaded availability:
  // if the feed hasn't loaded (empty) OR a shelf count is null (unknown), let Approve through and let
  // the server decide — otherwise a slow/failed /availability call wrongly disables Approve (M2).
  const approveBlocked = React.useMemo(() => {
    if (!req || !isReviewZone) return false;
    if (!warehouseId) return true;
    if (availability.length === 0) return false; // availability not loaded yet — don't block; server re-checks
    return req.lines.some((l) => {
      const need = trims[l.id] ?? l.requestedQty;
      if (need === 0) return false; // excluded — fine
      const src = sources[l.id] ?? warehouseId;
      const shelf = src ? shelfOf(l.irmItemId, src) : null;
      return shelf !== null && shelf < need; // block ONLY on a KNOWN shortfall (unknown ⇒ let server decide)
    });
  }, [req, isReviewZone, warehouseId, availability, trims, sources, shelfOf]);

  // ── Review actions ─────────────────────────────────────────────────────────────

  const onApprove = async () => {
    if (!req) return;
    // Re-entrancy guard: `disabled={busy}` alone can't stop two clicks dispatched inside ONE React
    // commit (double-click, or a scan gun's trailing Enter on the focused button) — setBusy is async,
    // so both would read busy===false and fire. The ref flips synchronously. Same reason the socket
    // handler reads busyRef.
    if (busyRef.current) return;
    if (!warehouseId) { setMsg({ type: "error", text: "Pick the fulfilment warehouse." }); return; }
    setBusyBoth(true);
    setMsg(null);
    try {
      // Send a line if its qty was trimmed OR its source differs from the primary. Excluded lines
      // (qty 0) carry no source. Unchanged lines are omitted (default to requestedQty @ primary).
      const lineApprovals = req.lines
        .map((l) => {
          const approvedQty = trims[l.id] ?? l.requestedQty;
          const src = sources[l.id] ?? warehouseId;
          const changed = approvedQty !== l.requestedQty || src !== warehouseId;
          return changed ? { lineId: l.id, approvedQty, ...(approvedQty > 0 && src ? { sourceWarehouseId: src } : {}) } : null;
        })
        .filter((x): x is { lineId: string; approvedQty: number; sourceWarehouseId?: string } => x !== null);
      await vanStockSvc.approveVanStockRequest(req.id, { warehouseId, lineApprovals: lineApprovals.length ? lineApprovals : undefined, decisionNote: decisionNote.trim() || undefined });
      pushToast("Request approved — fulfil it by scan.", "success");
      setMsg({ type: "success", text: "Approved — fulfil it by scan below." });
      load();
      onChanged();
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not approve the request." });
    } finally {
      setBusyBoth(false);
    }
  };

  const onDecline = async () => {
    if (!req) return;
    if (!declineNote.trim()) { setMsg({ type: "error", text: "A decline note is required." }); return; }
    setBusyBoth(true);
    setMsg(null);
    try {
      await vanStockSvc.declineVanStockRequest(req.id, declineNote.trim());
      pushToast("Request declined.", "success");
      setDeclineOpen(false);
      load();
      onChanged();
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not decline the request." });
    } finally {
      setBusyBoth(false);
    }
  };

  // ── Fulfil actions ─────────────────────────────────────────────────────────────

  // The ONLY way an entry is created — every posted line carries the code that was scanned (or typed)
  // off the item, so nothing can be posted that wasn't physically read. The server requires
  // `scannedCode` too, so a direct API call can't bypass this.
  //
  // ⚠️ These scan rules are DELIBERATELY MIRRORED from goods-management/JobScanPanel.tsx `onCode`:
  // in-flight guard → dead-scan message → re-scan bumps the good qty (one scan = one unit; a scan-gun
  // must never sit silent, or staff re-scan and miscount) → otherwise stage at qty 1. Same for the
  // good/damaged split (`setPortion`) and the post-time evidence rules.
  //
  // The BEHAVIOUR is mirrored; the CODE is not. FulfilRow and GM's ScanLine are now close cousins, but
  // they sit on different documents (a VSR line vs a job kit line), different lookups, and GM carries an
  // issue/return direction toggle plus misc no-barcode lines that VSR has no concept of. A shared hook
  // would have to model all of that — so the deliberate trade is duplication over a leaky abstraction.
  // If you change the scan/split rules HERE, change them THERE too (and vice versa). If the two ever
  // need to diverge on purpose, say so here. The scanner widget itself IS shared (ScannerInput).
  const onScan = async (code: string) => {
    if (!req || scanning) return;
    setScanning(true);
    setMsg(null);
    try {
      const result = await vanStockSvc.vanStockScanLookup(req.id, code);
      const line = req.lines.find((l) => l.id === result.lineId);
      if (!line || !line.isMine) {
        setMsg({ type: "error", text: `"${result.itemName}" is fulfilled by another warehouse.` });
        return;
      }
      // Nothing left to move — say so here rather than staging a line the server would reject on Post.
      if (line.remainingQty <= 0) {
        setMsg({ type: "error", text: `"${line.itemName}" is already fully fulfilled on this request.` });
        return;
      }
      // This scan's lookup is the freshest truth for both numbers: a split-fulfilment sibling may have
      // posted against this line since it was staged, so a row's snapshot can be stale. Refresh the row
      // from it on every bump, or the qty box keeps offering a cap the server will reject at Post.
      const fresh = { remainingQty: line.remainingQty, available: result.available };
      const cap = entryCap(fresh);
      // Read the CART through the ref, not the closure: `scanning` gates only the network window, so a
      // scan gun firing again before React commits the previous bump would re-read a stale `entries`
      // and write the same qty twice — three scans posting two units. The ref always holds what was
      // last committed, and the updater below stays pure (React may invoke it twice).
      const staged = entriesRef.current.find((e) => e.lineId === line.id);
      if (staged && rowTotal(staged) >= cap) {
        // At the cap — refresh the row's numbers from this lookup, but don't bump.
        setEntries((rows) => rows.map((r) => (r.lineId === line.id ? { ...r, ...fresh } : r)));
        setMsg({ type: "error", text: `"${line.itemName}": ${cap} is the most you can post — adjust the quantities if that's wrong.` });
        return;
      }
      setEntries((rows) => {
        // Start at 1 and climb per scan (GM's model — one scan, one unit). Bulk loads can still type the
        // quantity straight into the box, which clamps to the same cap.
        if (!rows.some((e) => e.lineId === line.id)) {
          return [...rows, { lineId: line.id, itemName: line.itemName, goodQty: 1, damagedQty: 0, ...fresh, scannedCode: code }];
        }
        // Re-scan bumps the GOOD portion (GM's model). Damaged units are entered deliberately in the
        // damaged box, never by scanning — so the cap is what's left after the damaged split.
        return rows.map((r) => (r.lineId === line.id ? { ...r, ...fresh, goodQty: r.goodQty + 1, scannedCode: code } : r));
      });
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Scan failed." });
    } finally {
      setScanning(false);
    }
  };

  const setEntry = (lineId: string, patch: Partial<FulfilRow>) =>
    setEntries((rows) => rows.map((r) => (r.lineId === lineId ? { ...r, ...patch } : r)));
  const removeEntry = (lineId: string) => setEntries((rows) => rows.filter((r) => r.lineId !== lineId));

  // The ONLY way a good/damaged portion changes (mirrors JobScanPanel's setPortion). Clamps to
  // 0..(cap − the other portion) so the two halves can never overshoot what the request owes / the van
  // holds, and — critically — CLEARS the damage evidence when the damaged portion drops to 0, so a photo
  // taken for units that are no longer being written off can never be posted against a later, unrelated
  // damaged qty. Centralised because a caller that forgets either rule silently corrupts a write-off.
  const setPortion = (lineId: string, field: "goodQty" | "damagedQty", next: number) =>
    setEntries((rows) =>
      rows.map((r) => {
        if (r.lineId !== lineId) return r;
        const other = field === "goodQty" ? r.damagedQty : r.goodQty;
        const val = Math.min(Math.max(0, Math.floor(next || 0)), Math.max(0, entryCap(r) - other));
        const patch: Partial<FulfilRow> = { [field]: val };
        if (field === "damagedQty" && val === 0) {
          patch.damagePhotoDataUrl = undefined;
          patch.damagePhotoUrl = undefined;
          patch.damageReason = undefined;
          patch.uploading = undefined;
        }
        return { ...r, ...patch };
      }),
    );

  // Show the picked photo straight away (data URI) and swap in the hosted URL once the upload lands —
  // the reviewer sees what they captured while it's still in flight (GM's onPhotoPicked). A failure
  // clears BOTH, so a preview can never imply evidence the posting doesn't actually carry.
  const onDamagePhoto = async (lineId: string, file: File | null) => {
    if (!file) return;
    try {
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read the photo."));
        reader.readAsDataURL(file);
      });
      setEntry(lineId, { damagePhotoDataUrl: dataUri, uploading: true });
      const url = await vanStockSvc.uploadVanStockDamagePhoto(dataUri);
      setEntry(lineId, { damagePhotoUrl: url, uploading: false });
    } catch (err) {
      setEntry(lineId, { damagePhotoDataUrl: undefined, damagePhotoUrl: undefined, uploading: false });
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not upload the photo." });
    }
  };

  const onPost = async () => {
    // Re-entrancy guard: this handler MOVES STOCK, and `disabled={busy}` can't stop two clicks batched
    // into one React commit (double-click / scan-gun trailing Enter) — setBusy is async, so both would
    // read busy===false and post twice. The ref flips synchronously. (The server's in-tx remaining-qty
    // cap would reject the second post, so this prevents a spurious 409 + duplicate audit noise rather
    // than a double issue — but the guard belongs here regardless.)
    if (busyRef.current) return;
    // Read the CART through the ref, not the `entries` closure: a scan that resolved in this same commit
    // is already in the ref but may be a render behind in state (see the setEntries/entriesRef contract
    // above) — validating and posting the stale copy would silently drop that unit.
    const rows = entriesRef.current;
    if (!req || rows.length === 0) { setMsg({ type: "error", text: "Scan at least one item to post." }); return; }
    // Mirrors JobScanPanel.onPost's return validation: a row must move something, and any damaged
    // portion needs its evidence (photo + reason) with the upload finished — a half-uploaded photo would
    // post a damaged write-off with no proof.
    for (const e of rows) {
      if (rowTotal(e) < 1) {
        setMsg({ type: "error", text: `"${e.itemName}": set a quantity (good and/or damaged).` });
        return;
      }
      if (e.damagedQty > 0) {
        if (e.uploading) { setMsg({ type: "error", text: `"${e.itemName}": the damage photo is still uploading — please wait.` }); return; }
        if (!e.damagePhotoUrl) { setMsg({ type: "error", text: `"${e.itemName}": a damage photo is required for the damaged units.` }); return; }
        if (!e.damageReason?.trim()) { setMsg({ type: "error", text: `"${e.itemName}": a damage reason is required for the damaged units.` }); return; }
      }
    }
    setBusyBoth(true);
    setMsg(null);
    try {
      // One UI row fans out to a Good entry and/or a Damaged entry — the backend sums entries per lineId
      // against the line's remaining qty, and routes each by its own condition (good → warehouse shelf,
      // damaged → damaged pool). Zero-qty halves are dropped, never sent.
      const payload: FulfilEntryPayload[] = rows.flatMap((e) => {
        const out: FulfilEntryPayload[] = [];
        if (e.goodQty > 0) out.push({ lineId: e.lineId, qty: e.goodQty, condition: "good", scannedCode: e.scannedCode });
        if (e.damagedQty > 0) {
          out.push({ lineId: e.lineId, qty: e.damagedQty, condition: "damaged", damagePhotoUrl: e.damagePhotoUrl, damageReason: e.damageReason?.trim() || undefined, scannedCode: e.scannedCode });
        }
        return out;
      });
      await vanStockSvc.fulfilVanStockRequest(req.id, payload);
      pushToast(req.type === "return" ? "Return received — balances updated." : "Stock issued — balances updated.", "success");
      setMsg({ type: "success", text: "Posted — stock and ledgers updated." });
      load();
      onChanged();
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not post the fulfilment." });
    } finally {
      setBusyBoth(false);
    }
  };

  const onCloseShort = async () => {
    if (!req) return;
    if (!closeShortNote.trim()) { setMsg({ type: "error", text: "Say why the remainder won't be fulfilled." }); return; }
    setBusyBoth(true);
    setMsg(null);
    try {
      await vanStockSvc.closeVanStockShort(req.id, closeShortNote.trim());
      pushToast("Closed short — remaining quantity written off.", "success");
      setCloseShortOpen(false);
      load();
      onChanged();
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not close the request." });
    } finally {
      setBusyBoth(false);
    }
  };

  // A row whose good+damaged both sit at 0 moves nothing, so it can't be posted (GM's postLineCount gate).
  const canPost = entries.length > 0 && entries.every((e) => rowTotal(e) > 0);

  // Only lines this warehouse owns (isMine, server-computed) are scan-able; others are read-only context.
  const openLines = (req?.lines ?? []).filter((l) => l.remainingQty > 0 && l.isMine);
  const otherLines = (req?.lines ?? []).filter((l) => l.remainingQty > 0 && !l.isMine);
  // This reviewer's own part is settled (every own-line fulfilled or closed short) — even though the
  // REQUEST is still partially_fulfilled because OTHER warehouses' lines are open. When that's true we
  // hide this warehouse's scan box + Close-short (there's nothing left for them to act on) and show a
  // "waiting for other warehouses" state instead, so we never render a control that would only error.
  const myPartDone = !!req?.myProgress?.allMineDone;

  return (
    <Modal open onClose={busy ? () => {} : onClose} title={req ? `${req.code} — ${req.type === "return" ? "Stock return" : "Restock request"}` : "Field stock request"} subtitle={req ? `${req.engineerName}${req.warehouseName ? ` · ${req.warehouseName}` : ""}` : undefined} size="lg" scrollBody>
      {!req ? (
        msg ? (
          <Notice msg={msg} />
        ) : (
          <DetailSkeleton />
        )
      ) : (
        <div className="space-y-5">
          {/* ── Info ─────────────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2">
            <VanStockStatusChip value={req.status} />
            {req.stale && <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-amber-600">Stale</span>}
            {req.priority !== "normal" && <span className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-red-600">{req.priority}</span>}
            {req.createdVia === "walk_in" && <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--muted)]">Walk-in</span>}
            <span className="ml-auto text-[11px] text-[var(--faint)]">{fmtDateTime(req.createdAt)}</span>
          </div>

          {/* Per-warehouse progress: "your part is done" even while the request is still partial overall. */}
          {req.myProgress && req.myProgress.lines > 0 && (
            <div className={`rounded-lg border px-3 py-2 text-xs font-semibold ${req.myProgress.allMineDone ? "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]" : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]"}`}>
              {req.myProgress.allMineDone ? "✓ Your part is complete" : `Your lines: ${req.myProgress.linesDone}/${req.myProgress.lines} done`}
              {req.progress.lines > req.myProgress.lines && <span className="ml-2 font-normal text-[var(--faint)]">· Overall {req.progress.linesDone}/{req.progress.lines}</span>}
            </div>
          )}

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <p className="text-xs text-[var(--muted)]"><span className="font-bold text-[var(--faint)]">Reason:</span> {req.reason}</p>
            {req.notes && <p className="mt-1 text-xs text-[var(--muted)]"><span className="font-bold text-[var(--faint)]">Notes:</span> {req.notes}</p>}
            {req.decisionNote && <p className="mt-1 text-xs text-[var(--muted)]"><span className="font-bold text-[var(--faint)]">Review note:</span> {req.decisionNote}</p>}
            {req.closeShortNote && <p className="mt-1 text-xs text-[var(--muted)]"><span className="font-bold text-[var(--faint)]">Closed short:</span> {req.closeShortNote}</p>}
            {req.attachments.length > 0 && (
              <p className="mt-1 text-xs text-[var(--muted)]">
                <span className="font-bold text-[var(--faint)]">Attachments:</span>{" "}
                {req.attachments.map((url, i) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer" className="mr-2 font-semibold text-[var(--accent)] hover:underline">#{i + 1}</a>
                ))}
              </p>
            )}
          </div>

          {/* Lines */}
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-2)] text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="px-3 py-2 text-left">Item</th>
                  <th className="w-24 px-3 py-2 text-right">Requested</th>
                  <th className="w-28 px-3 py-2 text-right">{isReviewZone ? "Approve qty" : "Approved"}</th>
                  {isReviewZone ? (
                    <th className="w-56 px-3 py-2 text-right">Source warehouse</th>
                  ) : req.type === "restock" && (req.status === "approved" || req.status === "partially_fulfilled") ? (
                    <th className="w-40 px-3 py-2 text-right">Source</th>
                  ) : null}
                  <th className="w-24 px-3 py-2 text-right">Fulfilled</th>
                </tr>
              </thead>
              <tbody>
                {req.lines.map((l) => {
                  const need = trims[l.id] ?? l.requestedQty;
                  return (
                  <tr key={l.id} className="border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]/50">
                    <td className="px-3 py-2 font-semibold text-[var(--ink)]">
                      {l.itemName}
                      {l.code && <div className="mt-0.5"><CopyableCode code={l.code} /></div>}
                    </td>
                    <td className="px-3 py-2 text-right text-[var(--muted)]">{l.requestedQty}</td>
                    <td className="px-3 py-2 text-right">
                      {isReviewZone ? (
                        <input
                          type="number"
                          min={0}
                          max={l.requestedQty}
                          step={1}
                          value={need}
                          aria-label={`Approved quantity for ${l.itemName}`}
                          onChange={(e) => setTrims((t) => ({ ...t, [l.id]: Math.min(l.requestedQty, Math.max(0, Math.floor(Number(e.target.value) || 0))) }))}
                          className={`${inputCls} py-1.5 text-right`}
                        />
                      ) : (
                        <span className="text-[var(--muted)]">{l.approvedQty ?? "—"}</span>
                      )}
                    </td>
                    {isReviewZone ? (
                      <td className="px-3 py-2">
                        {need === 0 ? (
                          <span className="block text-right text-[11px] font-bold uppercase text-[var(--faint)]">Excluded</span>
                        ) : (
                          <div className="space-y-1">
                            <Select
                              size="sm"
                              ariaLabel={`Source warehouse for ${l.itemName}`}
                              value={sources[l.id] ?? warehouseId}
                              onChange={(v) => setSources((s) => ({ ...s, [l.id]: v }))}
                              options={sourceOptionsFor(l.irmItemId, sources[l.id] ?? warehouseId).map((w) => {
                                const shelf = shelfOf(l.irmItemId, w.id);
                                return { value: w.id, label: `${w.code ? `${w.name} (${w.code})` : w.name}${shelf !== null ? ` — ${shelf} on shelf` : ""}` };
                              })}
                            />
                            {(() => {
                              const src = sources[l.id] ?? warehouseId;
                              const shelf = src ? shelfOf(l.irmItemId, src) : null;
                              if (shelf === null) return null;
                              const cls = shelf >= need ? "text-[var(--pos)]" : shelf > 0 ? "text-amber-600" : "text-[var(--neg)]";
                              // A 0-shelf line has two very different remedies, and the hint must name the
                              // right one: stocked elsewhere ⇒ re-point the source (the dropdown holds it);
                              // stocked NOWHERE ⇒ there is nothing to re-point to, so say so and point at the
                              // real exit (qty 0 = exclude), instead of sending the reviewer hunting a
                              // warehouse that doesn't exist.
                              const zeroHint = stockedSomewhere(l.irmItemId) ? "⚠ 0 here — pick another" : "⚠ Not stocked anywhere — set qty to 0 to exclude";
                              return <div className={`text-[10px] font-semibold ${cls}`}>{shelf >= need ? `✓ ${shelf} on shelf` : shelf > 0 ? `⚠ only ${shelf} here` : zeroHint}</div>;
                            })()}
                          </div>
                        )}
                      </td>
                    ) : req.type === "restock" && (req.status === "approved" || req.status === "partially_fulfilled") ? (
                      <td className="px-3 py-2 text-right text-[11px] text-[var(--muted)]">
                        {l.approvedQty === 0 ? (
                          <span className="font-bold uppercase text-[var(--faint)]">Excluded</span>
                        ) : (
                          l.sourceWarehouseCode ?? l.sourceWarehouseName ?? "—"
                        )}
                        {l.isMine && l.approvedQty !== 0 && <span className="ml-1 rounded bg-[var(--accent)]/10 px-1 text-[9px] font-bold uppercase text-[var(--accent)]">Yours</span>}
                      </td>
                    ) : null}
                    <td className="px-3 py-2 text-right text-[var(--muted)]">{l.fulfilledQty}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Review zone (pending restock) ────────────────────────────────── */}
          {isReviewZone && (
            <div className="space-y-3 rounded-xl border border-[var(--border)] p-3">
              <p className="text-xs font-bold text-[var(--faint)]">Review</p>
              {otherOpen.length > 0 && (
                <Notice msg={{ type: "error", text: `Other open requests from ${req.engineerName}: ${otherOpen.join(", ")} — check for duplicates before approving.` }} />
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>Primary warehouse <span className="text-[var(--neg)]">*</span></label>
                  <Select
                    ariaLabel="Primary warehouse"
                    value={warehouseId}
                    onChange={(v) => {
                      // Re-default every line's source that the reviewer hasn't manually re-pointed.
                      setSources((prev) => Object.fromEntries(req.lines.map((l) => [l.id, prev[l.id] && prev[l.id] !== warehouseId ? prev[l.id] : v])));
                      setWarehouseId(v);
                    }}
                    options={[{ value: "", label: "Pick a warehouse…" }, ...warehouses.map((w) => ({ value: w.id, label: w.code ? `${w.name} (${w.code})` : w.name }))]}
                  />
                  {req.preferredWarehouseName && <p className="mt-1 text-[11px] text-[var(--faint)]">Engineer is collecting from: {req.preferredWarehouseName}</p>}
                  <p className="mt-1 text-[11px] text-[var(--faint)]">Sets each line&apos;s default source — re-point out-of-stock lines below.</p>
                </div>
                <div>
                  <label className={labelCls}>Decision note (optional)</label>
                  <input value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} maxLength={2000} placeholder="e.g. Trimmed ties to shelf stock." className={inputCls} />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setDeclineOpen(true)} disabled={busy} className={secondaryBtn}>
                  <X className="h-3.5 w-3.5" /> Decline
                </button>
                <button type="button" onClick={onApprove} disabled={busy || approveBlocked} className={primaryBtn}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Approve
                </button>
              </div>
              {approveBlocked && (
                <p className="text-right text-[11px] font-semibold text-[var(--neg)]">Every line needs a source warehouse holding enough stock (or set its qty to 0 to exclude it).</p>
              )}
            </div>
          )}

          {/* This warehouse is done but the request is still open elsewhere — no scan box, just context. */}
          {isFulfilZone && myPartDone && otherLines.length > 0 && (
            <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)] p-3">
              <p className="text-xs font-bold text-[var(--faint)]">Waiting on other warehouses</p>
              <div className="mt-1.5 space-y-0.5">
                {otherLines.map((l) => (
                  <p key={l.id} className="text-[11px] text-[var(--muted)]">
                    {l.itemName} ×{l.remainingQty} — <span className="font-semibold">{l.sourceWarehouseName ?? "another warehouse"}</span>
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* ── Fulfil zone ──────────────────────────────────────────────────── */}
          {isFulfilZone && !myPartDone && (
            <div className="space-y-3 rounded-xl border border-[var(--border)] p-3">
              <p className="text-xs font-bold text-[var(--faint)]">{req.type === "return" ? "Scan the returned stock in" : "Scan the stock out"}</p>
              <ScannerInput onCode={onScan} disabled={busy || scanning} placeholder={req.type === "return" ? "Scan or type an IRM code / barcode to receive…" : "Scan or type an IRM code / barcode to issue…"} />

              {/* Outstanding lines are REFERENCE ONLY — every entry must come through the scanner, so the
                  posted stock is what was physically read off the item (matches Goods Management, which has
                  no manual add for catalogue items). The lookup resolves code | barcode | SKU, so an item
                  without a printed barcode is still reachable by typing its IRM code. */}
              {openLines.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {openLines.map((l) => {
                    const staged = entries.some((e) => e.lineId === l.id);
                    return (
                      <span
                        key={l.id}
                        className={`rounded-lg border border-dashed px-2.5 py-1 text-[11px] font-semibold ${staged ? "border-[var(--pos)]/40 text-[var(--pos)]" : "border-[var(--border)] text-[var(--muted)]"}`}
                      >
                        {staged ? "✓ " : ""}{l.itemName} ({l.remainingQty} left)
                      </span>
                    );
                  })}
                </div>
              )}

              {otherLines.length > 0 && (
                <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] p-2.5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Other warehouses</p>
                  <div className="mt-1 space-y-0.5">
                    {otherLines.map((l) => (
                      <p key={l.id} className="text-[11px] text-[var(--muted)]">
                        {l.itemName} ×{l.remainingQty} — <span className="font-semibold">{l.sourceWarehouseName ?? "another warehouse"}</span>
                      </p>
                    ))}
                  </div>
                </div>
              )}

              {entries.length > 0 && (
                <div className="space-y-2">
                  {entries.map((e) => (
                    <div key={e.lineId} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-[var(--ink)]">{e.itemName}</p>
                          <p className="text-[11px] text-[var(--faint)]">
                            {e.remainingQty} left on request{e.available !== null ? ` · ${e.available} ${req.type === "return" ? "on the van" : "on the shelf"}` : ""}
                            {req.type === "return" && rowTotal(e) > 0 && <span className="ml-1 font-semibold text-[var(--ink)]">· returning {rowTotal(e)}</span>}
                          </p>
                        </div>
                        {req.type === "return" ? (
                          // Split the line across both pools in ONE posting (3 good + 2 damaged). Each box
                          // clamps to the cap MINUS the other half, so the total can never exceed what the
                          // request owes / the van holds.
                          <>
                            <div>
                              <label className={`${labelCls} text-[var(--pos)]`} htmlFor={`good-${e.lineId}`}>Good</label>
                              <input
                                id={`good-${e.lineId}`}
                                type="number"
                                min={0}
                                max={entryCap(e) - e.damagedQty}
                                step={1}
                                value={e.goodQty}
                                onChange={(ev) => setPortion(e.lineId, "goodQty", Number(ev.target.value))}
                                className={`${inputCls} w-20 py-1.5 text-right`}
                              />
                            </div>
                            <div>
                              <label className={`${labelCls} text-[var(--neg)]`} htmlFor={`dmg-${e.lineId}`}>Damaged</label>
                              <input
                                id={`dmg-${e.lineId}`}
                                type="number"
                                min={0}
                                max={entryCap(e) - e.goodQty}
                                step={1}
                                value={e.damagedQty}
                                onChange={(ev) => setPortion(e.lineId, "damagedQty", Number(ev.target.value))}
                                className={`${inputCls} w-20 py-1.5 text-right`}
                              />
                            </div>
                          </>
                        ) : (
                          // Restock issues good stock only — no damaged leg, and never 0 (remove the row
                          // instead), so it floors at 1 rather than going through setPortion.
                          <input
                            type="number"
                            min={1}
                            max={entryCap(e)}
                            step={1}
                            value={e.goodQty}
                            aria-label={`Quantity for ${e.itemName}`}
                            onChange={(ev) => setEntry(e.lineId, { goodQty: Math.min(entryCap(e), Math.max(1, Math.floor(Number(ev.target.value) || 1))) })}
                            className={`${inputCls} w-24 py-1.5 text-right`}
                          />
                        )}
                        <button type="button" onClick={() => removeEntry(e.lineId)} aria-label={`Remove ${e.itemName}`} className="rounded-lg border border-[var(--border)] p-1.5 text-[var(--muted)] transition-all hover:border-[var(--neg)] hover:text-[var(--neg)]">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {/* Evidence is demanded by the DAMAGED portion, whatever the good portion is — a
                          3-good + 2-damaged row still needs a photo + reason for those 2 written-off units. */}
                      {e.damagedQty > 0 && (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <div>
                            <label className={labelCls}>Damage photo <span className="text-[var(--neg)]">*</span></label>
                            {e.damagePhotoDataUrl ? (
                              <div className="flex items-center gap-2">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={e.damagePhotoDataUrl} alt="Damage preview" className="h-16 w-24 rounded-lg border border-[var(--border)] object-cover" />
                                {e.uploading ? (
                                  <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading…
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setEntry(e.lineId, { damagePhotoDataUrl: undefined, damagePhotoUrl: undefined })}
                                    className="flex items-center gap-1 text-[11px] font-bold text-[var(--neg)] hover:underline"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" /> Remove
                                  </button>
                                )}
                              </div>
                            ) : (
                              <label className={`${secondaryBtn} cursor-pointer`}>
                                <Camera className="h-3.5 w-3.5" /> Add photo
                                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(ev) => onDamagePhoto(e.lineId, ev.target.files?.[0] ?? null)} />
                              </label>
                            )}
                          </div>
                          <div>
                            <label className={labelCls}>Damage reason <span className="text-[var(--neg)]">*</span></label>
                            <input value={e.damageReason ?? ""} onChange={(ev) => setEntry(e.lineId, { damageReason: ev.target.value })} maxLength={2000} placeholder="e.g. Crushed in transit." className={inputCls} />
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2">
                {/* Close short only when THIS warehouse still has an open own-line to write off — never for
                    lines owned by another warehouse (its manager closes those). */}
                {req.status === "partially_fulfilled" && openLines.length > 0 && (
                  <button type="button" onClick={() => setCloseShortOpen(true)} disabled={busy} className={secondaryBtn}>
                    Close short
                  </button>
                )}
                <button type="button" onClick={onPost} disabled={busy || !canPost} className={primaryBtn}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />} Post {req.type === "return" ? "return" : "issue"}
                </button>
              </div>
            </div>
          )}

          {/* Decline (pending only, both types) — returns have no review zone, so give them the button here. */}
          {canDecline && !isReviewZone && (
            <div className="flex justify-end">
              <button type="button" onClick={() => setDeclineOpen(true)} disabled={busy} className={secondaryBtn}>
                <X className="h-3.5 w-3.5" /> Decline return
              </button>
            </div>
          )}

          {/* Fulfilment history */}
          {req.fulfilments.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-bold text-[var(--faint)]">Postings</p>
              <div className="space-y-1.5">
                {req.fulfilments.map((f) => (
                  <div key={f.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-xs text-[var(--muted)]">
                    <span className="font-bold text-[var(--ink)]">#{f.sequence}</span> · {fmtDateTime(f.postedAt)} · {f.performedBy}
                    <div className="mt-0.5">
                      {f.lines.map((fl) => (
                        <span key={fl.id} className="mr-3">
                          {fl.itemName} ×{fl.qty}
                          {fl.condition === "damaged" && (
                            <>
                              {" "}
                              <span className="font-bold text-[var(--neg)]">damaged</span>
                              {fl.damagePhotoUrl && (
                                <a href={fl.damagePhotoUrl} target="_blank" rel="noreferrer" className="ml-1 font-semibold text-[var(--accent)] hover:underline">photo</a>
                              )}
                            </>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {msg && <Notice msg={msg} />}
        </div>
      )}

      {/* Decline modal */}
      {declineOpen && req && (
        <Modal
          open
          onClose={busy ? () => {} : () => setDeclineOpen(false)}
          title={`Decline ${req.code}`}
          subtitle="The engineer sees this note"
          size="sm"
          footer={
            <>
              <button type="button" onClick={() => setDeclineOpen(false)} disabled={busy} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)] disabled:opacity-60">Back</button>
              <button type="button" onClick={onDecline} disabled={busy} className={dangerBtn}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Decline
              </button>
            </>
          }
        >
          <div>
            <label className={labelCls}>Why is this declined? <span className="text-[var(--neg)]">*</span></label>
            <textarea value={declineNote} onChange={(e) => setDeclineNote(e.target.value)} rows={2} maxLength={2000} className={`${inputCls} resize-none`} />
          </div>
        </Modal>
      )}

      {/* Close-short modal */}
      {closeShortOpen && req && (
        <Modal
          open
          onClose={busy ? () => {} : () => setCloseShortOpen(false)}
          title={`Close ${req.code} short`}
          subtitle="Finalises the request at what's been fulfilled so far"
          size="sm"
          footer={
            <>
              <button type="button" onClick={() => setCloseShortOpen(false)} disabled={busy} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)] disabled:opacity-60">Back</button>
              <button type="button" onClick={onCloseShort} disabled={busy} className={primaryBtn}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Close short
              </button>
            </>
          }
        >
          <div>
            <label className={labelCls}>Why won&apos;t the remainder be fulfilled? <span className="text-[var(--neg)]">*</span></label>
            <textarea value={closeShortNote} onChange={(e) => setCloseShortNote(e.target.value)} rows={2} maxLength={2000} className={`${inputCls} resize-none`} />
          </div>
        </Modal>
      )}
    </Modal>
  );
}
