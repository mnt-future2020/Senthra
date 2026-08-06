"use client";

import * as React from "react";
import { ArrowLeft, Camera, Check, CheckCircle2, ImageUp, Loader2, PackageCheck, Trash2, X } from "lucide-react";

import * as vanStockSvc from "@/services/vanStockRequest.service";
import type { FulfilEntryPayload, VanStockRequest, WarehouseAvailability } from "@/services/vanStockRequest.service";
import { subscribe } from "@/lib/socket";
import { cn } from "@/lib/utils";
import { useDashboard } from "@/hooks/useDashboard";
import { CopyableCode } from "@/components/ui/CopyableCode";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { QtyStepper } from "@/components/ui/QtyStepper";
import { Skeleton } from "@/components/ui/Skeleton";
import { dangerBtn, inputCls, labelCls, primaryBtn, secondaryBtn } from "@/components/ui/styles";
import { fmtDateTime } from "@/components/dashboard/portal/portalUi";
import { ScannerInput } from "@/components/dashboard/goods-management/ScannerInput";
import { VanStockAttachments, VanStockCompletionBadge, VanStockPostings, VanStockWalkInBadge, linesForWarehouse, warehouseStatus } from "./vanRequestUi";
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
  uom: string | null; // unit label shown next to the qty stepper (e.g. "Box")
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

// Loading placeholder — mirrors the loaded layout (status chips → reason card → lines table) so the
// workspace doesn't jump when the request arrives.
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

// One request's review workspace — fills the warehouse tab in place of the queue (see
// VanRequestsWorkspace). `idOrCode` is normally the code from the URL; the backend's getOne takes
// either, so an old `?vReq=<objectId>` link still resolves.
export function VanRequestDetail({ idOrCode, warehouseName, currentWarehouseId, onClose }: { idOrCode: string; warehouseName: string; currentWarehouseId: string; onClose: () => void }) {
  const { pushToast } = useDashboard();
  const [req, setReq] = React.useState<VanStockRequest | null>(null);
  // TOAST vs `msg`, and the split is about whether the user would SEE it, not severity:
  //  • toast — the scan/post zone (an inline error there lands below the fold while the scanner keeps
  //    focus, so "no active catalogue item matches that code" is simply never read) and the Decline /
  //    Close-short dialogs (whose own errors would render on the page BEHIND the modal). Matches
  //    goods-management's JobScanPanel, which toasts every scan outcome.
  //  • msg  — the load failure, and the approve zone, which renders beside the button that raised it.
  const [msg, setMsg] = React.useState<Msg>(null);
  const [busy, setBusy] = React.useState(false);

  // Review state (pending restock)
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
      .getVanStockRequest(idOrCode)
      .then((r) => {
        if (seq !== fetchSeq.current) return; // superseded by a newer fetch
        setReq(r);
        // Seed the per-line source dropdowns from the engineer's own choice — they pick a collection
        // warehouse per item at create, so the reviewer's table should open showing that route rather
        // than an empty "Select…" they have to re-enter. Only fills BLANKS, so a re-point the reviewer
        // has already made survives a socket-driven refresh.
        setSources((prev) => {
          const next = { ...prev };
          for (const l of r.lines) if (!next[l.id] && l.sourceWarehouseId) next[l.id] = l.sourceWarehouseId;
          return next;
        });
        setEntries([]);
      })
      .catch((err) => {
        if (seq !== fetchSeq.current) return;
        setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load the request." });
      });
  }, [idOrCode, setEntries]); // setEntries is stable (useCallback, no deps) — this never re-triggers the load

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
        .getVanStockRequest(idOrCode)
        .then((r) => {
          if (seq !== fetchSeq.current) return; // a newer load()/event won — don't rewind `req`
          setReq(r);
        })
        .catch(() => {}); // background refresh — a transient failure just leaves the last-known state
    };
    return subscribe(["van_stock_request:updated"], onEvent);
  }, [idOrCode]);
  // Free stock per warehouse — it feeds the "N free" beside each line's source and the shortfall guard
  // on Approve.
  //
  // Gated on the request being LIVE, not on `status === "pending"`. Review is per warehouse now: the
  // first warehouse to answer moves the request to `approved`, so a second warehouse still holding
  // undecided lines was landing on that early return — no availability, no free-stock figure beside
  // its source, and the client-side shortfall check silently disabled (it treats an empty feed as
  // "not loaded yet" and defers to the server).
  React.useEffect(() => {
    if (!req || req.type !== "restock") return;
    if (["declined", "cancelled", "fulfilled"].includes(req.status)) return;
    const ids = req.lines.map((l) => l.irmItemId);
    vanStockSvc.getVanStockAvailability(ids).then(setAvailability).catch(() => setAvailability([]));
  }, [req]);
  // NB "free", not "on shelf": /availability subtracts stock already planned on active jobs, so this
  // is what can actually be taken — the same number and the same word the engineer's composer shows.
  const shelfOf = React.useCallback(
    (irmItemId: string, whId: string): number | null => {
      const w = availability.find((a) => a.warehouseId === whId);
      if (!w) return null;
      return w.items.find((i) => i.irmItemId === irmItemId)?.quantityOnHand ?? 0;
    },
    [availability],
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

  // MY undecided lines — what this warehouse still owes an answer on. Review is no longer a property
  // of the REQUEST's status: the first warehouse to approve moves it to `approved`, and the second
  // must still be able to answer for its own lines. Legacy lines carry no source; they stay reviewable
  // here so pre-per-line requests remain approvable by the warehouse looking at them.
  const myPendingLines = React.useMemo(
    () => (req?.lines ?? []).filter((l) => l.approvedQty === null && (!l.sourceWarehouseId || l.sourceWarehouseId === currentWarehouseId)),
    [req, currentWarehouseId],
  );
  const isReviewZone = req?.type === "restock" && !["declined", "cancelled", "fulfilled"].includes(req.status) && myPendingLines.length > 0;
  const myPendingIds = React.useMemo(() => new Set(myPendingLines.map((l) => l.id)), [myPendingLines]);
  // The lines this warehouse handles — the ONLY ones its table shows. It reviews, issues and closes
  // short its own lines, so another warehouse's stock here was noise it couldn't act on, and it made
  // the request read as bigger than this warehouse's share of it. The count of what's elsewhere is
  // still surfaced below the table, so nothing disappears silently.
  const myLines = React.useMemo(() => linesForWarehouse(req?.lines ?? [], currentWarehouseId), [req, currentWarehouseId]);
  const otherLineCount = (req?.lines.length ?? 0) - myLines.length;
  const lineIsMine = React.useCallback((l: { id: string }) => myPendingIds.has(l.id), [myPendingIds]);
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
    // MY undecided lines only. Gating on every line let another warehouse's line — or one it had
    // already answered and excluded, which carries no qty of its own — disable this warehouse's
    // Approve, with nothing on screen to fix because that line isn't even shown here any more.
    if (myPendingLines.some((l) => (trims[l.id] ?? l.requestedQty) > 0 && !sources[l.id])) return true;
    if (availability.length === 0) return false; // availability not loaded yet — don't block; server re-checks
    return myPendingLines.some((l) => {
      const need = trims[l.id] ?? l.requestedQty;
      if (need === 0) return false; // excluded — fine
      const shelf = shelfOf(l.irmItemId, sources[l.id]!);
      return shelf !== null && shelf < need; // block ONLY on a KNOWN shortfall (unknown ⇒ let server decide)
    });
  }, [req, isReviewZone, myPendingLines, availability, trims, sources, shelfOf]);

  // ── Review actions ─────────────────────────────────────────────────────────────

  const onApprove = async () => {
    if (!req) return;
    // Re-entrancy guard: `disabled={busy}` alone can't stop two clicks dispatched inside ONE React
    // commit (double-click, or a scan gun's trailing Enter on the focused button) — setBusy is async,
    // so both would read busy===false and fire. The ref flips synchronously. Same reason the socket
    // handler reads busyRef.
    if (busyRef.current) return;
    if (myPendingLines.length === 0) { setMsg({ type: "error", text: "There are no lines here for you to review." }); return; }
    setBusyBoth(true);
    setMsg(null);
    try {
      // ONLY this warehouse's own undecided lines. Sending every line was how a super admin — who has
      // no warehouse scope, so the server couldn't narrow it either — approved another warehouse's
      // lines from this tab: the warehouse that actually held that stock never got to answer, and its
      // review zone was already gone by the time it opened the request.
      const lineApprovals = myPendingLines.map((l) => {
        const approvedQty = trims[l.id] ?? l.requestedQty;
        return { lineId: l.id, approvedQty, ...(approvedQty > 0 ? { sourceWarehouseId: sources[l.id] ?? currentWarehouseId } : {}) };
      });
      await vanStockSvc.approveVanStockRequest(req.id, { warehouseId: currentWarehouseId, lineApprovals, decisionNote: decisionNote.trim() || undefined });
      pushToast("Request approved — fulfil it by scan.", "success");
      load();
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not approve the request." });
    } finally {
      setBusyBoth(false);
    }
  };

  const onDecline = async () => {
    if (!req) return;
    if (!declineNote.trim()) { pushToast("A decline note is required.", "alert"); return; }
    setBusyBoth(true);
    setMsg(null);
    try {
      await vanStockSvc.declineVanStockRequest(req.id, currentWarehouseId, declineNote.trim());
      pushToast("Request declined.", "success");
      setDeclineOpen(false);
      load();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not decline the request.", "alert");
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
      const result = await vanStockSvc.vanStockScanLookup(req.id, currentWarehouseId, code);
      const line = req.lines.find((l) => l.id === result.lineId);
      // Only issue lines sourced to THIS warehouse tab — even an admin (isMine everywhere) must scan a
      // line out of the warehouse it's sourced from, not whichever tab they happen to be viewing.
      if (!line || !line.isMine || line.sourceWarehouseId !== currentWarehouseId) {
        pushToast(`"${result.itemName}" is issued from ${line?.sourceWarehouseName ?? "another warehouse"} — open that warehouse's queue to scan it.`, "alert");
        return;
      }
      // Nothing left to move — say so here rather than staging a line the server would reject on Post.
      if (line.remainingQty <= 0) {
        pushToast(`"${line.itemName}" is already fully fulfilled on this request.`, "alert");
        return;
      }
      // This scan's lookup is the freshest truth for both numbers: a split-fulfilment sibling may have
      // posted against this line since it was staged, so a row's snapshot can be stale. Refresh the row
      // from it on every bump, or the qty box keeps offering a cap the server will reject at Post.
      const fresh = { remainingQty: line.remainingQty, available: result.available, uom: result.uom };
      const cap = entryCap(fresh);
      // Read the CART through the ref, not the closure: `scanning` gates only the network window, so a
      // scan gun firing again before React commits the previous bump would re-read a stale `entries`
      // and write the same qty twice — three scans posting two units. The ref always holds what was
      // last committed, and the updater below stays pure (React may invoke it twice).
      const staged = entriesRef.current.find((e) => e.lineId === line.id);
      if (staged && rowTotal(staged) >= cap) {
        // At the cap — refresh the row's numbers from this lookup, but don't bump.
        setEntries((rows) => rows.map((r) => (r.lineId === line.id ? { ...r, ...fresh } : r)));
        pushToast(`"${line.itemName}": ${cap} is the most you can post — adjust the quantities if that's wrong.`, "alert");
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
      pushToast(err instanceof Error ? err.message : "Scan failed.", "alert");
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
      pushToast(err instanceof Error ? err.message : "Could not upload the photo.", "alert");
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
    if (!req || rows.length === 0) { pushToast("Scan at least one item to post.", "alert"); return; }
    // Mirrors JobScanPanel.onPost's return validation: a row must move something, and any damaged
    // portion needs its evidence (photo + reason) with the upload finished — a half-uploaded photo would
    // post a damaged write-off with no proof.
    for (const e of rows) {
      if (rowTotal(e) < 1) {
        pushToast(`"${e.itemName}": set a quantity (good and/or damaged).`, "alert");
        return;
      }
      if (e.damagedQty > 0) {
        if (e.uploading) { pushToast(`"${e.itemName}": the damage photo is still uploading — please wait.`, "alert"); return; }
        if (!e.damagePhotoUrl) { pushToast(`"${e.itemName}": a damage photo is required for the damaged units.`, "alert"); return; }
        if (!e.damageReason?.trim()) { pushToast(`"${e.itemName}": a damage reason is required for the damaged units.`, "alert"); return; }
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
      await vanStockSvc.fulfilVanStockRequest(req.id, currentWarehouseId, payload);
      pushToast(req.type === "return" ? "Return received — balances updated." : "Stock issued — balances updated.", "success");
      load();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not post the fulfilment.", "alert");
    } finally {
      setBusyBoth(false);
    }
  };

  const onCloseShort = async () => {
    if (!req) return;
    if (!closeShortNote.trim()) { pushToast("Say why the remainder won't be fulfilled.", "alert"); return; }
    setBusyBoth(true);
    setMsg(null);
    try {
      await vanStockSvc.closeVanStockShort(req.id, currentWarehouseId, closeShortNote.trim());
      pushToast("Closed short — the remaining quantity won't be supplied.", "success");
      setCloseShortOpen(false);
      load();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not close the request.", "alert");
    } finally {
      setBusyBoth(false);
    }
  };

  // A row whose good+damaged both sit at 0 moves nothing, so it can't be posted (GM's postLineCount gate).
  const canPost = entries.length > 0 && entries.every((e) => rowTotal(e) > 0);

  // Scan-able HERE = lines sourced to the warehouse whose tab we're in (currentWarehouseId) AND owned by
  // the actor (isMine, server-computed). The source-warehouse match is the key: a warehouse's stock is
  // issued from THAT warehouse's own tab, never another's. This scopes an admin — who "owns" every line
  // via isMine — to the warehouse they're actually viewing, exactly like a scoped manager would be. Any
  // other outstanding line is read-only context pointing at its own source (go issue it from there).
  const openLines = (req?.lines ?? []).filter((l) => l.remainingQty > 0 && l.isMine && l.sourceWarehouseId === currentWarehouseId);
  const otherLines = (req?.lines ?? []).filter((l) => l.remainingQty > 0 && !(l.isMine && l.sourceWarehouseId === currentWarehouseId));

  return (
    // Fills WarehouseDetail's `fill` box: pinned header, ONE scrolling body. The reviewer keeps the
    // warehouse header + tab strip above them, so this reads as a place inside the warehouse rather
    // than an overlay on top of it.
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-start gap-3 border-b border-[var(--border)] pb-3">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          // Disabled (not ignored) mid-post: a scan-fulfil posting is in flight and navigating away
          // would strand the reviewer without its result. Mirrors the old modal's no-op onClose.
          title={busy ? "Finishing the current action…" : "Back to the queue"}
          className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border)] px-2.5 py-1.5 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:opacity-50"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Queue
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-extrabold text-[var(--ink)]">
            {req ? `${req.code} — ${req.type === "return" ? "Stock return" : "Restock request"}` : "Field stock request"}
          </h2>
          {/* The warehouse named here is the one you are WORKING IN, not the request's own. It used to
              print req.warehouseName — the request's derived primary — so a request first approved by
              London read "· London Logistics Hub" while you were stood in another warehouse's tab
              reviewing your own lines. */}
          <p className="truncate text-xs text-[var(--muted)]">{req ? `${req.engineerName} · ${warehouseName}` : warehouseName}</p>
        </div>
      </div>

      {/* Full width, like every other `fill` tab (the queue, Inventory, Incoming) — the reviewer's
          table needs the room, and a max-w here strands a third of the screen empty beside it. */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-6 pt-4">
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
            {(() => {
              const s = warehouseStatus(req, currentWarehouseId);
              return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${s.cls}`}>{s.label}</span>;
            })()}
            {/* Next to the status it qualifies: this "Approved" was never reviewed. */}
            <VanStockWalkInBadge createdVia={req.createdVia} />
            <VanStockCompletionBadge completionType={req.completionType} lines={req.lines} />
            {req.stale && <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-amber-600">Stale</span>}
            {req.priority !== "normal" && <span className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-red-600">{req.priority}</span>}
            {/* Per-warehouse progress ("your part is done" even while the request is still partial
                overall) rides with the other status chips — it's one short fact, and a full-width band
                of its own just to say "0/4 done" reads as a second, emptier card.
                ONLY on a SPLIT (this actor owns a strict subset of the lines — `progress.lines >
                myProgress.lines`): that's the sole case where "my part" can differ from the overall
                status. On a single-warehouse request every line is mine, so "your part complete" would
                just echo the "Fulfilled" chip — pure noise — and is suppressed. */}
            {req.myProgress && req.myProgress.lines > 0 && req.progress.lines > req.myProgress.lines && (
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${req.myProgress.allMineDone ? "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]" : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]"}`}>
                {req.myProgress.allMineDone ? "✓ Your part complete" : `Your lines ${req.myProgress.linesDone}/${req.myProgress.lines}`}
                <span className="ml-1 font-bold normal-case text-[var(--faint)]">· overall {req.progress.linesDone}/{req.progress.lines}</span>
              </span>
            )}
            <span className="ml-auto text-[11px] text-[var(--faint)]">{fmtDateTime(req.createdAt)}</span>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <p className="text-xs text-[var(--muted)]"><span className="font-bold text-[var(--faint)]">Reason:</span> {req.reason}</p>
            {req.notes && <p className="mt-1 text-xs text-[var(--muted)]"><span className="font-bold text-[var(--faint)]">Notes:</span> {req.notes}</p>}
            {req.decisionNote && <p className="mt-1 text-xs text-[var(--muted)]"><span className="font-bold text-[var(--faint)]">Review note:</span> {req.decisionNote}</p>}
            {req.closeShortNote && <p className="mt-1 text-xs text-[var(--muted)]"><span className="font-bold text-[var(--faint)]">Closed short:</span> {req.closeShortNote}</p>}
            <VanStockAttachments urls={req.attachments} className="mt-2" />
          </div>

          {/* Duplicate context sits ABOVE the lines — the reviewer must weigh "has he already asked for
              this?" BEFORE trimming quantities, not after. In the old modal it was buried under a
              scrolling table, so a reviewer could approve having never seen it.
              Amber, not red: nothing is broken and nothing is blocked — it's a "look before you approve"
              caution, sized like the reviewer warning on job kit requests. Deliberately NOT <Notice>,
              which is the full-width banner forms use to report a submit result. */}
          {isReviewZone && otherOpen.length > 0 && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] font-semibold text-amber-600">
              Other open requests from {req.engineerName}: {otherOpen.join(", ")} — check for duplicates before approving.
            </p>
          )}

          {/* No bulk "set all lines from" control: the engineer now picks a collection warehouse PER
              LINE at create (against that warehouse's live free stock), so the route arrives already
              decided. Re-pointing every line at once is the wholesale override this flow was changed
              to avoid — a reviewer who genuinely needs to move a line still has its own dropdown in
              the table below. */}
          {/* Lines. overflow-x-auto + the table's min-w: at full width every column fits and nothing
              scrolls (the old modal's 32rem box is what truncated the warehouse names); on a narrow
              viewport the table scrolls sideways rather than crushing the source dropdown. Same
              wrapper shape as purchase-requests / goods-in. */}
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            {/* Columns are UNSIZED and left-aligned — the same shape as every other lines table in the
                app (purchase-requests, goods-in, the shared VanRequestLinesTable). Hand-picked `w-*`
                widths here are what left Item hogging the slack while the data columns crowded. */}
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-2)] text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3">Requested</th>
                  <th className="px-4 py-3">{isReviewZone ? "Approve qty" : "Approved"}</th>
                  {isReviewZone ? (
                    <th className="px-4 py-3">Source warehouse</th>
                  ) : req.type === "restock" && (req.status === "approved" || req.status === "partially_fulfilled") ? (
                    <th className="px-4 py-3">Source</th>
                  ) : null}
                  <th className="px-4 py-3">Fulfilled</th>
                </tr>
              </thead>
              <tbody>
                {myLines.map((l) => {
                  const need = trims[l.id] ?? l.requestedQty;
                  return (
                  <tr key={l.id} className="border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]/50">
                    {/* The NAME is the copy target, matching the goods queue — it is the thing being
                        read, and the scan box for this very request sits further down the page. The
                        code is NOT printed underneath: it is on the hover tooltip and in the "Copied
                        IRM-0004" confirmation, so a permanent second line would repeat what the row
                        already offers and push every row taller for it. */}
                    <td className="px-4 py-3">
                      <div className="font-semibold text-[var(--ink)]">
                        {l.code ? <CopyableCode code={l.code} label={l.itemName} className="text-left" onCopied={(c) => pushToast(`Copied ${c}`)} /> : l.itemName}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">{l.requestedQty}</td>
                    <td className="px-4 py-3">
                      {isReviewZone && lineIsMine(l) ? (
                        <input
                          type="number"
                          min={0}
                          max={l.requestedQty}
                          step={1}
                          value={need}
                          aria-label={`Approved quantity for ${l.itemName}`}
                          onChange={(e) => setTrims((t) => ({ ...t, [l.id]: Math.min(l.requestedQty, Math.max(0, Math.floor(Number(e.target.value) || 0))) }))}
                          // w-20 via cn(): a qty is 1-4 digits, so inputCls's w-full just leaves a long
                          // empty box (goods-management's scan stepper sizes its qty box the same way).
                          // twMerge drops the w-full — a bare template string would leave both classes
                          // and let source order decide.
                          className={cn(inputCls, "w-20 py-1.5 text-right")}
                        />
                      ) : (
                        <span className="text-[var(--muted)]">
                          {l.approvedQty ?? "—"}
                          {/* A dropped line reads as a bare "0" once the request is past review — the
                              Excluded marker only ever showed in the source column DURING review, and
                              that column disappears afterwards. Same reasoning as the closed-short and
                              cancelled markers: a zero with no word beside it is a number to
                              reverse-engineer, not an answer. */}
                          {l.approvedQty === 0 && (
                            <span className="ml-1.5 whitespace-nowrap text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                              · excluded
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    {isReviewZone ? (
                      <td className="px-3 py-2">
                        {need === 0 ? (
                          <span className="block text-right text-[11px] font-bold uppercase text-[var(--faint)]">Excluded</span>
                        ) : (
                          <div className="space-y-1">
                            {/* The source is READ-ONLY. The engineer chose this warehouse against its
                                live free stock and planned their drive around it, and each warehouse
                                now answers only for its own lines — so re-pointing a line would both
                                redirect the engineer without asking and hand the line to a warehouse
                                that has to approve it all over again. A warehouse that can't supply a
                                line trims it, excludes it (qty 0), or declines its own lines; the
                                engineer is told and re-requests from somewhere that has it. */}
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="text-xs font-semibold text-[var(--ink)]">
                                {l.sourceWarehouseName ?? "—"}
                              </span>
                              {(() => {
                                // Free stock at that warehouse, shown next to its name — the same
                                // number the engineer chose against, and what the reviewer judges the
                                // qty by. It disappeared when this cell became read-only.
                                const free = l.sourceWarehouseId ? shelfOf(l.irmItemId, l.sourceWarehouseId) : null;
                                if (free === null) return null;
                                return <span className="text-[10px] font-semibold text-[var(--muted)]">· {free} free</span>;
                              })()}
                              {!lineIsMine(l) && (
                                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                                  {l.approvedQty === null ? "Another warehouse" : "Answered"}
                                </span>
                              )}
                            </div>
                            {(() => {
                              const src = sources[l.id];
                              const shelf = src ? shelfOf(l.irmItemId, src) : null;
                              if (shelf === null) return null;
                              const cls = shelf >= need ? "text-[var(--pos)]" : shelf > 0 ? "text-amber-600" : "text-[var(--neg)]";
                              // A 0-shelf line has two very different remedies, and the hint must name the
                              // right one: stocked elsewhere ⇒ re-point the source (the dropdown holds it);
                              // stocked NOWHERE ⇒ there is nothing to re-point to, so say so and point at the
                              // real exit (qty 0 = exclude), instead of sending the reviewer hunting a
                              // warehouse that doesn't exist.
                              const zeroHint = stockedSomewhere(l.irmItemId) ? "⚠ 0 here — pick another" : "⚠ Not stocked anywhere — set qty to 0 to exclude";
                              return <div className={`text-[10px] font-semibold ${cls}`}>{shelf >= need ? `✓ ${shelf} free` : shelf > 0 ? `⚠ only ${shelf} here` : zeroHint}</div>;
                            })()}
                          </div>
                        )}
                      </td>
                    ) : req.type === "restock" && (req.status === "approved" || req.status === "partially_fulfilled") ? (
                      <td className="px-4 py-3 text-[11px] text-[var(--muted)]">
                        {l.approvedQty === 0 ? (
                          <span className="font-bold uppercase text-[var(--faint)]">Excluded</span>
                        ) : (
                          l.sourceWarehouseCode ?? l.sourceWarehouseName ?? "—"
                        )}
                        {/* "Yours" = sourced to the warehouse tab you're viewing (scan it here), not
                            merely in the actor's scope — else an admin sees every line as "Yours". */}
                        {l.isMine && l.sourceWarehouseId === currentWarehouseId && l.approvedQty !== 0 && <span className="ml-1 rounded bg-[var(--accent)]/10 px-1 text-[9px] font-bold uppercase text-[var(--accent)]">Yours</span>}
                      </td>
                    ) : null}
                    <td className="px-4 py-3 text-[var(--muted)]">
                      {l.fulfilledQty}
                      {/* A closed-short line used to read "approved 6 · fulfilled 0" — identical to one
                          nobody had touched. The qty makes the arithmetic add up again, and the reason
                          (captured at close-short and previously shown to nobody) rides on the title.
                          "Closed short", not "written off" — see the note in lineProgress. */}
                      {(l.closedShortQty ?? 0) > 0 && (
                        <span
                          className="ml-1.5 whitespace-nowrap text-[10px] font-bold uppercase tracking-wider text-amber-600"
                          title={[l.closedShortNote, l.closedShortBy && `— ${l.closedShortBy}`].filter(Boolean).join(" ")}
                        >
                          · {l.closedShortQty} closed short
                        </span>
                      )}
                      {/* The ENGINEER gave up on this qty, not this warehouse — so it is named
                          separately and in neutral grey, not the amber this warehouse's own
                          close-short wears. Without it the row read "approved 3 · fulfilled 0" on a
                          request marked Fulfilled, with nothing saying why nothing was issued. */}
                      {(l.cancelledQty ?? 0) > 0 && (
                        <span
                          className="ml-1.5 whitespace-nowrap text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]"
                          title={l.cancelledBy ? `Cancelled by ${l.cancelledBy}` : "Cancelled by the engineer"}
                        >
                          · {l.cancelledQty} cancelled by engineer
                        </span>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* The rest of the request still exists — say so without listing stock this warehouse can
              neither issue nor decide on. */}
          {otherLineCount > 0 && (
            <p className="text-[11px] text-[var(--faint)]">
              {otherLineCount} more {otherLineCount === 1 ? "item is" : "items are"} handled by another warehouse.
            </p>
          )}

          {/* ── Review zone (pending restock) ────────────────────────────────── */}
          {isReviewZone && (
            <div className="space-y-3 rounded-xl border border-[var(--border)] p-3">
              <p className="text-xs font-bold text-[var(--faint)]">Review</p>
              <div>
                {/* NOT shown to the engineer (their list only surfaces a DECLINE note) — this is
                    reviewer-to-reviewer. It earns its keep on a SPLIT: when a line is re-pointed to
                    another warehouse, that warehouse's manager opens the request off their own queue
                    with no idea why it reached them. This note is that context. */}
                <label className={labelCls}>Review note (optional)</label>
                <input value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} maxLength={2000} placeholder="e.g. No ties in London — re-pointed to Manchester." className={inputCls} />
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
              {/* Beside the button that raised it — a rejected approve/decline must be visible without
                  scrolling, right where the reviewer just clicked. */}
              {msg && <Notice msg={msg} />}
            </div>
          )}

          {/* Nothing for THIS warehouse to issue (its lines are done, or it never owned any) while the
              request is still open elsewhere — no scan box, just context pointing at each line's source. */}
          {isFulfilZone && openLines.length === 0 && otherLines.length > 0 && (
            <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)] p-3">
              <p className="text-xs font-bold text-[var(--faint)]">Issued from other warehouses — open each warehouse&apos;s queue to scan it</p>
              <div className="mt-1.5 space-y-0.5">
                {otherLines.map((l) => (
                  <p key={l.id} className="text-[11px] text-[var(--muted)]">
                    {l.itemName} ×{l.remainingQty} — <span className="font-semibold">{l.sourceWarehouseName ?? "another warehouse"}</span>
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* ── Fulfil zone ── only when THIS warehouse has lines to issue ────── */}
          {isFulfilZone && openLines.length > 0 && (
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
                <div className="space-y-3">
                  {entries.map((e) => (
                    // Mirrors goods-management/JobScanPanel's scanned-line card so the two scan surfaces
                    // read as one system: name + counts on the left, a compact ± stepper on the right.
                    <div key={e.lineId} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-bold text-[var(--ink)]">{e.itemName}</p>
                          <p className="text-xs text-[var(--muted)]">
                            {e.remainingQty} left on request{e.available !== null ? ` · ${e.available} ${req.type === "return" ? "on the van" : "on the shelf"}` : ""}
                            {req.type === "return" && rowTotal(e) > 0 && <span className="ml-1 font-semibold text-[var(--ink)]">· returning {rowTotal(e)}</span>}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {/* Restock issues good stock only — a single stepper in the header. It never
                              goes to 0 (remove the row instead), so it floors at 1. Returns move their
                              good/damaged steppers below the header. */}
                          {req.type !== "return" && (
                            <QtyStepper
                              value={e.goodQty}
                              min={1}
                              max={entryCap(e)}
                              uom={e.uom}
                              ariaLabel={`Quantity for ${e.itemName}`}
                              onChange={(v) => setEntry(e.lineId, { goodQty: Math.min(entryCap(e), Math.max(1, Math.floor(v || 1))) })}
                            />
                          )}
                          <button type="button" onClick={() => removeEntry(e.lineId)} aria-label={`Remove ${e.itemName}`} className="ml-2 flex h-7 w-7 items-center justify-center rounded-lg text-[var(--faint)] transition-all hover:text-[var(--neg)]">
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </div>

                      {/* Return-only: split the line across both pools in ONE posting (3 good + 2 damaged).
                          Each stepper clamps to the cap MINUS the other half (setPortion), so the total can
                          never exceed what the request owes / the van holds. Mirrors goods-management/
                          JobScanPanel's return card — Good row, then a Damaged box that owns its own qty
                          AND (when > 0) the red-accented photo + reason evidence nested inside it. */}
                      {req.type === "return" && (
                        <div className="mt-3 space-y-2">
                          {/* Good portion */}
                          <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
                            <span className="flex items-center gap-1.5 text-xs font-bold text-[var(--pos)]">
                              <CheckCircle2 className="h-4 w-4" /> Good
                            </span>
                            <QtyStepper
                              value={e.goodQty}
                              min={0}
                              max={entryCap(e) - e.damagedQty}
                              uom={e.uom}
                              ariaLabel={`Good quantity for ${e.itemName}`}
                              onChange={(v) => setPortion(e.lineId, "goodQty", v)}
                            />
                          </div>

                          {/* Damaged portion — box owns the qty header AND the evidence block below it */}
                          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
                            <div className="flex items-center justify-between gap-3">
                              <span className="flex items-center gap-1.5 text-xs font-bold text-[var(--neg)]">
                                <Trash2 className="h-4 w-4" /> Damaged
                              </span>
                              <QtyStepper
                                value={e.damagedQty}
                                min={0}
                                max={entryCap(e) - e.goodQty}
                                uom={e.uom}
                                ariaLabel={`Damaged quantity for ${e.itemName}`}
                                onChange={(v) => setPortion(e.lineId, "damagedQty", v)}
                              />
                            </div>

                            {/* Evidence is demanded by the DAMAGED portion, whatever the good portion is — a
                                3-good + 2-damaged row still needs a photo + reason for those 2 written-off units. */}
                            {e.damagedQty > 0 && (
                              <div className="mt-2 ml-1 space-y-2 border-l-2 border-[var(--neg)] pl-3">
                                {/* Photo */}
                                <div>
                                  <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Damage photo <span className="text-[var(--neg)]">*</span></p>
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
                                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[11px] font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)]">
                                      <Camera className="h-3.5 w-3.5" /> <ImageUp className="h-3.5 w-3.5" /> Attach photo
                                      <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(ev) => onDamagePhoto(e.lineId, ev.target.files?.[0] ?? null)} />
                                    </label>
                                  )}
                                </div>
                                {/* Reason */}
                                <div>
                                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]" htmlFor={`reason-${e.lineId}`}>Damage reason <span className="text-[var(--neg)]">*</span></label>
                                  <input id={`reason-${e.lineId}`} type="text" value={e.damageReason ?? ""} onChange={(ev) => setEntry(e.lineId, { damageReason: ev.target.value })} maxLength={2000} placeholder="Describe the damage…" className={inputCls} />
                                </div>
                              </div>
                            )}
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

          {/* Fulfilment history — shared with the engineer's list so both sides read the same record
              of what physically moved (and, on a return, what came back damaged). */}
          {/* Scoped to this warehouse's own lines — another warehouse's issue is its history, not ours. */}
          <VanStockPostings fulfilments={req.fulfilments} type={req.type} lineIds={new Set(myLines.map((l) => l.id))} />

        </div>
      )}
      </div>

      {/* Decline / Close-short stay MODALS: each is one focused decision with a mandatory note, taken
          on top of this workspace and dismissed. They sit outside the scrolling body — they overlay
          the page, they aren't part of its flow. */}
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
            <textarea value={declineNote} onChange={(e) => setDeclineNote(e.target.value)} rows={2} maxLength={2000} placeholder="e.g. Already collected on VSR-0025 — duplicate request." className={`${inputCls} resize-none`} />
          </div>
        </Modal>
      )}

      {/* Close-short modal */}
      {closeShortOpen && req && (
        <Modal
          open
          onClose={busy ? () => {} : () => setCloseShortOpen(false)}
          title={`Close ${req.code} short`}
          subtitle="Finalises the request at what's been fulfilled — the engineer sees this note"
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
            <textarea value={closeShortNote} onChange={(e) => setCloseShortNote(e.target.value)} rows={2} maxLength={2000} placeholder="e.g. Out of stock — raise a new request when restocked." className={`${inputCls} resize-none`} />
          </div>
        </Modal>
      )}
    </div>
  );
}
