/**
 * WHICH custody records carry a date that is a migration artefact, and what the date should be.
 *
 * Pure, and separate from the script that runs it, because this is the part that can be wrong in a way
 * nobody would see: it rewrites a historical date on rows that already look right on screen. Every rule
 * below is pinned by a test in `custody-declared-at.plan.test.ts`.
 *
 * ── The artefact ───────────────────────────────────────────────────────────────────────────────
 *
 * `HireCustodyExit.declaredAt` could not be supplied by a caller — the column simply took `now()`. The
 * backfill that created a hire's damage history therefore dated every row it wrote to the afternoon it
 * ran, and `recomputeCountersTx` then copied that day onto the hire line's `fieldDamageReportedAt`,
 * overwriting the real one. The damage panel reads the row, so "found on the 23rd" showed as the 24th.
 *
 * ── What is allowed to move ────────────────────────────────────────────────────────────────────
 *
 * ONLY rows a migration wrote. A return scan and a loss declaration are the declaration itself, so
 * their `now()` is the fact and is never touched. Nothing is guessed: a row with no evidence behind it
 * is reported as unexplained and left exactly as it is — a date that is honestly unknown is worth more
 * than one this script invented.
 */

import { instantForDay } from "../utils/calendar-day.js";

/** The two source types a migration wrote, and the only ones this will move. */
const MIGRATED_FIELD_DAMAGE = "backfill_field_damage";
const MIGRATED_FROM_NOTE = "warehouse_damage_note";

/**
 * How far a record may sit from its own note and still be the LIVE one.
 *
 * A note and its records are written in one transaction, so they are the same second in practice. A
 * migrated row is hours or months away. A minute is far wider than the first and far narrower than the
 * second, so nothing real lands in between.
 */
const WRITTEN_WITH_ITS_NOTE_MS = 60_000;

export interface ExitRow {
  id: string;
  purchaseOrderRentalLineId: string;
  poCode: string | null;
  itemName: string;
  sourceType: string;
  sourceId: string;
  declaredAt: Date;
}

/** A damaged unit coming back off a job — the movement line that reported it, and when. */
export interface DamageSighting {
  purchaseOrderRentalLineId: string;
  createdAt: Date;
}

/** A damage note: the day it reports, and the moment it was written. */
export interface NoteRow {
  id: string;
  deliveryDate: Date;
  createdAt: Date;
}

export interface Repair {
  id: string;
  from: Date;
  to: Date;
  /** Printed by the runner, so a dry run says what it is about to trust. */
  reason: string;
  row: ExitRow;
}

export interface RepairPlan {
  repairs: Repair[];
  /** Migrated rows with nothing to date them from. Reported, never guessed at. */
  unexplained: ExitRow[];
}

/**
 * A slice cut off a record — it shares its parent's date exactly, so it must follow any repair to it.
 *
 * ALL FOUR key shapes, because there are four writers that split a row and copy `declaredAt` off it,
 * not one. Matching only `<kind>_split_N` left the other two carrying the migration artefact date
 * forever, silently, on rows whose parent had just been corrected beside them:
 *
 *   • `damage_split_N` / `loss_split_N`   — settleOpenAgainstNoteTx, a note accepting part of a report
 *   • `damage_custody_split_N`            — reconcileDamageCustodyTx, damage that went back with the kit
 *   • `loss_recovery_N`                   — recoverHireLoss, units that turned up after being declared gone
 *
 * A recovery is a split like any other here: the recovered slice is the SAME declaration, cut in two,
 * and a date it no longer shares with its parent describes a second event that never happened.
 */
const SPLIT_KEY = /^(?:damage|loss)_split_\d+$|^damage_custody_split_\d+$|^loss_recovery_\d+$/;
const splitParentOf = (row: ExitRow): string | null => (SPLIT_KEY.test(row.sourceType) ? row.sourceId : null);

export function planDeclaredAtRepairs(rows: ExitRow[], sightings: DamageSighting[], notes: NoteRow[]): RepairPlan {
  const noteById = new Map(notes.map((n) => [n.id, n]));
  const repairs: Repair[] = [];
  const unexplained: ExitRow[] = [];

  for (const row of rows) {
    const verdict = trueDeclaredAt(row, sightings, noteById);
    if (verdict === "keep") continue;
    if (verdict === "unknown") {
      unexplained.push(row);
      continue;
    }
    if (verdict.at.getTime() !== row.declaredAt.getTime()) repairs.push({ id: row.id, from: row.declaredAt, to: verdict.at, reason: reasonFor(row), row });
  }

  // Splits AFTER their parents, so a corrected parent is already in hand. One report cannot carry two
  // dates: the slice and the row it was cut from are the same fault, split only because a note accepted
  // part of it.
  //
  // TO A FIXED POINT, because a slice can itself be sliced: a note settles part of an engineer's report
  // (`damage_split_1`), and a later collection sends part of THAT back with the kit
  // (`damage_custody_split_1` keyed on it). One pass repairs the child and leaves the grandchild behind,
  // holding the artefact date beside a parent that has just moved — the same drift this exists to
  // close, one level down. Each pass can only extend the chain by one, so it converges in the depth of
  // the deepest chain and the bound is a backstop against a cycle in the data rather than a real limit.
  const moved = new Map(repairs.map((r) => [r.id, r.to]));
  for (let pass = 0; pass < rows.length; pass++) {
    let extended = false;
    for (const row of rows) {
      if (moved.has(row.id)) continue;
      const parent = splitParentOf(row);
      const to = parent === null ? undefined : moved.get(parent);
      if (!to) continue;
      moved.set(row.id, to);
      extended = true;
      if (to.getTime() !== row.declaredAt.getTime()) {
        repairs.push({ id: row.id, from: row.declaredAt, to, reason: `follows the record it was split from (${parent})`, row });
      }
    }
    if (!extended) break;
  }

  return { repairs, unexplained };
}

/**
 * What should happen to one row's date.
 *
 * THREE answers, not two. "Leave it, its date is its own" and "I cannot date this" look the same from
 * the outside and are not: the first is every ordinary row in the table, the second is a row a human
 * has to come and look at. Collapsing them buried five real records under thousands of fine ones.
 */
type Verdict = { at: Date } | "keep" | "unknown";

function trueDeclaredAt(row: ExitRow, sightings: DamageSighting[], noteById: Map<string, NoteRow>): Verdict {
  if (row.sourceType === MIGRATED_FIELD_DAMAGE) {
    // The EARLIEST damaged return on this hire, which is the same date `fieldDamageReportedAt` was
    // documented to hold. Only returns at or before the migrated date count: anything after it was
    // recorded by the live path and has a correctly-dated record of its own.
    let earliest: Date | null = null;
    for (const s of sightings) {
      if (s.purchaseOrderRentalLineId !== row.purchaseOrderRentalLineId) continue;
      if (s.createdAt.getTime() > row.declaredAt.getTime()) continue;
      if (earliest === null || s.createdAt.getTime() < earliest.getTime()) earliest = s.createdAt;
    }
    return earliest === null ? "unknown" : { at: earliest };
  }

  if (row.sourceType === MIGRATED_FROM_NOTE) {
    const note = noteById.get(row.sourceId);
    if (!note) return "unknown";
    // Written with its note, so the record is live and its instant is the truth.
    if (Math.abs(row.declaredAt.getTime() - note.createdAt.getTime()) <= WRITTEN_WITH_ITS_NOTE_MS) return "keep";
    // Otherwise the note's own reported day is what the record should have said all along.
    return { at: instantForDay(note.deliveryDate, note.createdAt) };
  }

  return "keep";
}

const reasonFor = (row: ExitRow): string =>
  row.sourceType === MIGRATED_FIELD_DAMAGE ? "the earliest damaged return on this hire" : `the day its note reports (${row.sourceId})`;
