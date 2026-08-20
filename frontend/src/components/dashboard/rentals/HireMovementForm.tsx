"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, PackageCheck } from "lucide-react";

import * as rentalService from "@/services/rental.service";
import * as poService from "@/services/purchase-order.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { useReportDirty } from "@/providers/NavigationGuardProvider";
import { ghostBtn, hintCls, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { NumberInput } from "@/components/ui/NumberInput";
import { AttachmentList, DocPicker } from "@/components/dashboard/goods-in/DeliveryDocuments";
import { Select } from "@/components/ui/Select";
import {
  FieldError,
  FormAsideCard,
  FormError,
  FormPageHeader,
  FormPageSkeleton,
  FormSection,
  RequiredMark,
  SummaryRow,
} from "@/components/ui/FormScaffold";
import { focusFirstInvalid } from "@/lib/focusFirstInvalid";
import { uploadDirect } from "@/lib/upload";
import type { PurchaseOrder } from "@/types/purchase-order";
import type { PoRentalLine, ReceiptCondition, ReceiptDirection } from "@/types/rental";

// Recording a MOVEMENT of hired kit — the rental counterpart of a goods receipt, and deliberately not
// one. A GRN's completion writes an inventory balance and a stock movement; hired equipment stays the
// supplier's, so this records custody instead: how much moved, in what condition, carrying which of the
// supplier's asset tags.
//
// ONE component for all three legs — booking it in, handing it back, reporting it broken — because
// they are the same screen doing the same job. Three components would be three places for the copy,
// the caps, the photo handling and the layout to drift apart, and the person using them is the same
// person in the same yard. What differs is held in MODES below, where it can be read side by side.
//
// One screen, no draft. A GRN is drafted so the inventory write can be checked before it lands, and
// there is nothing here to defer — a mistake is voided afterwards, which keeps the quantities a hire
// moved on as the sum of records nobody rewrote.

const CONDITIONS: Record<ReceiptDirection, { value: ReceiptCondition; label: string }[]> = {
  in: [
    { value: "good", label: "Good — no damage on arrival" },
    { value: "damaged", label: "Damaged — see notes" },
  ],
  out: [
    { value: "good", label: "Good — going back as it came" },
    { value: "damaged", label: "Damaged — see notes" },
  ],
  damage: [],
};

// Deliberately NOT defaulted to "good". A preselected answer means somebody who saved without looking
// has certified that the supplier's equipment was undamaged — and that certificate is ours, in our own
// record, waiting to be quoted back at us when the damage is found later. The goods receipt can default
// its quality flag because the goods are ours either way; a hire goes back and gets inspected.
const NO_CONDITION = "";

// Matches the server's own caps on a movement (rental-receipt.service.ts) and the upload catalog's
// per-file ceiling — the picker enforces them so the user is not told by a failed upload.
const MAX_PHOTOS = 12;
const PHOTO_LIMITS = { maxCount: MAX_PHOTOS, maxBytes: 10 * 1024 * 1024, maxTotalBytes: 40 * 1024 * 1024 };
// The server's own EVIDENCE_IMAGE_TYPES (upload.catalog.ts), not a narrower guess — a .webp straight
// off a phone would otherwise never reach a picker that would have accepted it.
const PHOTO_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp";

const today = () => new Date().toISOString().slice(0, 10);

// UTC: a hire date is a calendar day stored as UTC midnight, and formatting it in the viewer's zone
// shows the previous day for anyone behind UTC.
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

/** Everything that differs between the three legs, in one place so it can be read side by side. */
interface Mode {
  title: string;
  submitLabel: string;
  /** The header section: dates, references, condition. */
  eventTitle: string;
  eventDescription: string;
  dateLabel: string;
  dateHint: string;
  dateMissing: string;
  /** Null on a damage report — nobody carried anything. */
  refLabel: string | null;
  refHint: string;
  refPlaceholder: string;
  partyLabel: string | null;
  partyHint: string;
  partyPlaceholder: string;
  conditionLabel: string;
  conditionPlaceholder: string;
  conditionHint: string;
  conditionMissing: string;
  /** The per-line section. */
  linesTitle: string;
  linesDescription: string;
  qtyLabel: string;
  /** Shown when no line on the order qualifies for this movement at all. */
  linesEmpty: string;
  /** The word for the running remainder each line is capped at. */
  remainderLabel: string;
  overLine: (n: number) => string;
  nothingEntered: string;
  photosTitle: string;
  photosDescription: string;
  photosHint: string;
  asideTitle: string;
  unitsLabel: string;
  asideNote: string;
  /** Only the arrival leg carries a separate "of those, damaged" column. */
  damagedColumn: boolean;
}

const MODES: Record<ReceiptDirection, Mode> = {
  in: {
    title: "Receive hired equipment",
    submitLabel: "Record delivery",
    eventTitle: "Delivery",
    eventDescription: "Hired kit stays the supplier's — this records that it arrived, not that we own it.",
    dateLabel: "Delivery date",
    dateHint: "The date this equipment physically arrived.",
    dateMissing: "When did it arrive?",
    refLabel: "Supplier delivery note",
    refHint: "Their reference for this drop — their side of any dispute.",
    refPlaceholder: "e.g. DN-2026-001",
    partyLabel: "Carrier",
    partyHint: "Who dropped the equipment off.",
    partyPlaceholder: "e.g. Own transport, DPD",
    conditionLabel: "Condition on arrival",
    conditionPlaceholder: "— How did it arrive? —",
    conditionHint: "A summary for the whole delivery; per-item damage is entered below.",
    conditionMissing: "Say what condition the equipment arrived in.",
    linesTitle: "What arrived",
    linesDescription: "Enter the units that actually turned up. A part delivery is ordinary — the rest stays outstanding.",
    qtyLabel: "Received now",
    linesEmpty: "Every hire line on this order has already been received in full.",
    remainderLabel: "Outstanding",
    overLine: (n) => `Only ${n} still outstanding on this line.`,
    nothingEntered: "Enter the quantity received on at least one line.",
    photosTitle: "Condition photos",
    photosDescription: "How the equipment looked as it came off the van. Kept as condition evidence for this hire and for the handover back.",
    photosHint: "Photograph anything you would not want to be charged for later.",
    asideTitle: "This delivery",
    unitsLabel: "Units received",
    asideNote:
      "Recording this puts the units above on hire — their return deadline and its reminder apply from here. Anything still outstanding stays on the receiving list. It adds nothing to inventory: hired equipment stays the supplier's.",
    damagedColumn: true,
  },
  out: {
    title: "Return hired equipment",
    submitLabel: "Record return",
    eventTitle: "Collection",
    eventDescription: "The handover back — the leg a damage charge is argued over, so it is recorded like one.",
    dateLabel: "Collection date",
    dateHint: "The date the equipment actually left us.",
    dateMissing: "When did it go back?",
    refLabel: "Supplier collection note",
    refHint: "Their reference for this collection — their side of any dispute.",
    refPlaceholder: "e.g. CN-2026-014",
    partyLabel: "Collected by",
    partyHint: "Who took the equipment away.",
    partyPlaceholder: "e.g. Supplier's van, own transport",
    conditionLabel: "Condition on return",
    conditionPlaceholder: "— How did it go back? —",
    conditionHint: "A summary for the whole collection; per-item damage is entered below.",
    conditionMissing: "Say what condition the equipment went back in.",
    linesTitle: "What went back",
    linesDescription: "Enter the units the supplier actually took. A part collection is ordinary — the rest stays on hire.",
    qtyLabel: "Returning now",
    linesEmpty: "Nothing from this order is still out — every received unit has already gone back.",
    remainderLabel: "Still out",
    overLine: (n) => `Only ${n} still out on this line.`,
    nothingEntered: "Enter the quantity returned on at least one line.",
    photosTitle: "Condition photos",
    photosDescription: "How the equipment looked as it went back. This is the evidence against a damage charge that arrives afterwards.",
    photosHint: "Photograph anything you do not want to be charged for.",
    asideTitle: "This return",
    unitsLabel: "Units returned",
    asideNote:
      "Recording this takes the units above off hire and stops their return deadline. A hire closes only once everything ordered has arrived and everything that arrived has gone back.",
    damagedColumn: true,
  },
  damage: {
    title: "Report hire damage",
    submitLabel: "File report",
    eventTitle: "Damage report",
    eventDescription: "Damage found while the equipment is with us — recorded when it happens, so it is evidence rather than a recollection.",
    dateLabel: "Date noticed",
    dateHint: "When the damage happened, or when it was found.",
    dateMissing: "When was the damage found?",
    refLabel: null,
    refHint: "",
    refPlaceholder: "",
    partyLabel: null,
    partyHint: "",
    partyPlaceholder: "",
    conditionLabel: "What happened",
    conditionPlaceholder: "",
    conditionHint: "The words a supplier's charge will be argued against. Be specific.",
    conditionMissing: "Describe what happened.",
    linesTitle: "What is damaged",
    linesDescription: "Only the units that are actually damaged. Nothing moves — the equipment is still here and still on hire.",
    qtyLabel: "Damaged units",
    linesEmpty: "Nothing here to report — every unit of this order that is with us is already recorded as damaged, or has gone back.",
    remainderLabel: "Not yet reported with us",
    overLine: (n) => `Only ${n} of this line is not already reported damaged with us.`,
    nothingEntered: "Enter how many units are damaged on at least one line.",
    photosTitle: "Photos",
    photosDescription: "What the damage looks like. A claim with no picture behind it is our word against the supplier's.",
    photosHint: "Photograph the damage from more than one angle.",
    asideTitle: "This report",
    unitsLabel: "Units damaged",
    asideNote:
      "This moves nothing: the equipment stays on hire and stays where it is. It records what is broken, when, and with what evidence — so the handover back is not the first time anybody hears about it.",
    damagedColumn: false,
  },
};

type LineState = {
  purchaseOrderRentalLineId: string;
  itemName: string;
  baseUnit: string | null;
  ordered: number;
  /** Units actually in our hands: received minus returned. The frame a damage report is read in. */
  held: number;
  /** What this movement counts against — already received / already returned / already reported. */
  alreadyMoved: number;
  /** The cap: outstanding to receive, still out to return, or held for a damage report. */
  remainder: number;
  /** The hire this movement is against — shown so nobody confirms the wrong period's kit. */
  hireStartDate: string;
  hireEndDate: string;
  /** Where this line is, resolved by the server. Lines can differ within one order. */
  destination: string;
  /** As typed. Blank means "none of this line moved", which is ordinary. */
  quantity: string;
  damaged: string;
  /** One box, comma separated — the supplier's tags come off a printed sheet, not one per keystroke. */
  assetTags: string;
  notes: string;
  /**
   * What the supplier is charging for the damage on this line, in POUNDS as typed. Usually left blank
   * here: the damage is written down the day it is found and the quote arrives days later, so the
   * figure is normally recorded afterwards from the movement panel on the order.
   */
  damageCharge: string;
};

/**
 * How each leg reads a hire line: which of them it applies to at all, what it is capped at, and what
 * the box starts out holding.
 *
 * Kept as one function rather than three filters scattered through the component, because "which lines
 * can this movement touch" is the rule the SERVER re-checks — and the two disagreeing is how a form
 * offers somebody a number the save then refuses.
 */
function readLine(direction: ReceiptDirection, r: PoRentalLine): LineState | null {
  const received = r.receivedQuantity ?? 0;
  const returned = r.returnedQuantity ?? 0;

  // A returned hire is off every list for good; a hire that has not arrived can neither go back nor be
  // damaged in our hands.
  if (direction !== "in" && r.hireStatus !== "on_hire") return null;
  if (direction === "in" && r.hireStatus === "returned") return null;

  // What this movement counts AGAINST, per direction. A damage report counts against nothing that has
  // moved — its running figure is what has already been reported broken, which is the number somebody
  // filing a second report needs to see so they do not report the same unit twice.
  const alreadyMoved = direction === "in" ? received : direction === "out" ? returned : (r.damagedQuantity ?? 0);
  // What is still to move, per direction. On a damage report that is what we HOLD minus what is
  // already reported damaged — the same cap the server applies, because this is a count of damaged
  // UNITS and not of damage events: the same unit reported twice would carry a running total no
  // number of units could justify.
  const remainder =
    direction === "in"
      ? r.quantity - received
      : direction === "out"
        ? received - returned
        : received - returned - (r.damagedQuantity ?? 0);
  if (remainder <= 0) return null;

  return {
    purchaseOrderRentalLineId: r.id,
    itemName: r.itemName,
    baseUnit: r.baseUnit,
    ordered: r.quantity,
    held: received - returned,
    alreadyMoved,
    remainder,
    hireStartDate: r.hireStartDate,
    hireEndDate: r.hireEndDate,
    // Where the kit is: on the way in that is where it is going, on the way back where it is coming
    // from. Both resolved by the same server function the order document prints from.
    destination:
      (direction === "in" ? r.deliveryLocation.address : r.returnLocation.address) ??
      (direction === "in" ? r.deliveryLocation.label : r.returnLocation.label),
    // Pre-filled with the whole remainder on the movements where "all of it" is the common case by far,
    // and BLANK on a damage report, where the common case is one broken unit out of five and a
    // pre-filled five would be a claim nobody meant to make.
    quantity: direction === "damage" ? "" : String(remainder),
    damaged: "",
    assetTags: "",
    notes: "",
    // NEVER pre-filled, for the same reason the damaged box is not: a figure the system put here is
    // an amount nobody agreed to, and this one is money.
    damageCharge: "",
  };
}

export function HireMovementForm({ poId, direction }: { poId: string; direction: ReceiptDirection }) {
  const router = useRouter();
  const { pushToast } = useDashboard();
  // The server stamps `receivedBy` from the session. Shown so the person signing for somebody else's
  // movement can see whose name is going on it.
  const { user } = useAuth();
  const me = user?.email ?? "this account";
  const mode = MODES[direction];

  const [po, setPo] = React.useState<PurchaseOrder | null>(null);
  /**
   * Damage ALREADY ON FILE for each hire line, split by whose it is: what arrived broken (the
   * supplier's, evidenced on their delivery note) and what broke while we held it (ours).
   *
   * Shown, never SUMMED and never pre-filled into the damaged box.
   *
   * Not summed, because the two can be the same physical unit or two different ones and nothing here
   * can tell: asset tags are optional. Not pre-filled, because this field is what the person doing
   * the handover OBSERVES — a number the system put there is a condition nobody re-checked, and on
   * the return leg it is worse than that: recording a unit that arrived broken as "damaged at return"
   * with no qualification is how the supplier's own fault becomes a charge to us.
   *
   * So the screen carries the facts and the person carries the judgement.
   */
  type PriorDamage = { units: number; codes: string[] };
  const [priorDamage, setPriorDamage] = React.useState<
    Record<string, { onArrival?: PriorDamage; withUs?: PriorDamage }>
  >({});

  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [lines, setLines] = React.useState<LineState[]>([]);
  const [movementDate, setMovementDate] = React.useState(today);
  const [party, setParty] = React.useState("");
  const [noteRef, setNoteRef] = React.useState("");
  // A damage report IS damaged — there is no question to answer, so it is not asked.
  const [condition, setCondition] = React.useState<ReceiptCondition | "">(
    direction === "damage" ? "damaged" : NO_CONDITION,
  );
  const [conditionNotes, setConditionNotes] = React.useState("");
  const [notes, setNotes] = React.useState("");
  // Held as FILES until the record exists — a photo attaches to a record, and there is none until the
  // save lands. `previewUrl` is an object URL held for the life of the staged row and revoked when it
  // goes: the list needs SOME src to render its preview, and a blob costs a pointer where a base64 copy
  // would cost 1.33× the file, in React state, per photo.
  const [photos, setPhotos] = React.useState<{ key: string; file: File; fileType: string; previewUrl: string }[]>([]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  // The supplier's quote or invoice number for whatever damage this note charges. Note-level: one
  // document covers the movement, and it is the string somebody reconciling an invoice searches for.
  const [damageChargeRef, setDamageChargeRef] = React.useState("");
  const [saved, setSaved] = React.useState(false);

  // Same guard every other form in the app uses — a half-typed record must not vanish on a stray
  // back-button, and a completed save must not challenge the navigation it caused.
  useReportDirty("hire-movement", dirty && !saved);

  React.useEffect(() => {
    let active = true;
    poService
      .getPurchaseOrder(poId)
      .then((order) => {
        if (!active) return;
        setPo(order);
        setLines(order.rentalItems.map((r) => readLine(direction, r)).filter((l): l is LineState => l !== null));
      })
      .catch((e) => active && setLoadError(e instanceof Error ? e.message : "Could not load the purchase order."));
    return () => {
      active = false;
    };
  }, [poId, direction]);

  // Only the legs that happen AFTER an arrival need it. On the receive form it would be telling the
  // person recording the arrival what they are in the middle of recording.
  React.useEffect(() => {
    if (!po || direction === "in") return;
    let active = true;
    rentalService
      .listHireDeliveries(po.id)
      .then((notes) => {
        if (!active) return;
        const live = notes.filter((n) => !n.reversedAt);
        const byLine: Record<string, { onArrival?: PriorDamage; withUs?: PriorDamage }> = {};
        for (const n of live) {
          // Deliveries carry the supplier's damage; damage REPORTS carry ours. A return note's own
          // damaged column is this same question asked at a previous handover and is left out — it
          // describes units that have already gone back.
          const side = n.direction === "in" ? "onArrival" : n.direction === "damage" ? "withUs" : null;
          if (!side) continue;
          for (const l of n.lines) {
            if (l.damagedQuantity <= 0) continue;
            const row = (byLine[l.purchaseOrderRentalLineId] ??= {});
            const bucket = (row[side] ??= { units: 0, codes: [] });
            bucket.units += l.damagedQuantity;
            bucket.codes.push(n.code);
          }
        }
        setPriorDamage(byLine);
      })
      // Deliberately silent: this is context, not a precondition. A failed read must not stop
      // somebody recording a collection that is happening in front of them.
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [po, direction]);

  // Every staged photo's object URL, released when the form goes away. Without it, leaving this page
  // with photos still staged keeps each file alive in memory until the tab closes.
  //
  // Read through the state updater rather than a ref — the same shape the goods-receipt form uses, and
  // the one the compiler-compat lint allows: a ref written during render is what it refuses.
  React.useEffect(() => {
    return () => {
      setPhotos((rows) => {
        for (const r of rows) URL.revokeObjectURL(r.previewUrl);
        return rows;
      });
    };
  }, []);

  const touch = () => {
    if (!dirty) setDirty(true);
  };
  const setLine = (idx: number, patch: Partial<LineState>) => {
    setLines((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    touch();
  };

  const num = (v: string) => (v.trim() === "" ? 0 : Number(v));
  /**
   * A money box as typed, in pounds — or UNDEFINED for an empty one.
   *
   * Deliberately not `num`: that reads a blank as 0, and 0 here is a claim ("they are charging us
   * nothing") rather than an absence ("no quote yet"). The two are stored differently and read
   * differently on every screen, so they must not be flattened on the way out.
   */
  const money = (v: string) => (v.trim() === "" ? undefined : Number(v));
  const tagCount = (v: string) => v.split(/[,\n]/).filter((t) => t.trim()).length;

  /**
   * What the ORDER expected, shown beside what is being recorded.
   *
   * These are two different facts and the screens were letting them look like one: the order carries a
   * confirmed delivery date (the supplier's promise), and this field carries the date the equipment
   * actually turned up — which is why it defaults to today rather than to the promise. Somebody who
   * has just read "Confirmed delivery 19 Aug" on the order and then sees 18 Aug here has no way to
   * tell which is wrong, and the honest answer is neither. So the promise is put on the screen.
   */
  const plannedArrival =
    direction === "in" ? (po?.confirmedDeliveryDate ?? po?.expectedDeliveryDate ?? null) : null;
  const plannedLabel = po?.confirmedDeliveryDate ? "Supplier confirmed" : "Expected";
  const totalMoved = lines.reduce((sum, l) => sum + (Number.isFinite(num(l.quantity)) ? num(l.quantity) : 0), 0);
  // On a damage report the quantity IS the damage, so there is no second column to add up.
  const totalDamaged = mode.damagedColumn
    ? lines.reduce((sum, l) => sum + (Number.isFinite(num(l.damaged)) ? num(l.damaged) : 0), 0)
    : totalMoved;

  // The lines this movement actually covers — everything below reports on those, not on the whole order.
  const active = lines.filter((l) => num(l.quantity) > 0);

  const earliestStart = active.map((l) => l.hireStartDate.slice(0, 10)).sort()[0];
  // The soonest deadline this delivery starts running — the earliest end date among the lines on it.
  const returnsBy = active.map((l) => l.hireEndDate).sort()[0];

  // A date before the hire it belongs to, or in the future, is nearly always a typo. A LATE arrival is
  // real and ordinary — it is called out because the return deadline does NOT move with it: the period
  // stays as it was ordered.
  const dateNotice = (() => {
    if (!movementDate) return null;
    if (movementDate > today()) return "That date is in the future — check it before saving.";
    if (!earliestStart) return null;
    if (movementDate < earliestStart) {
      return direction === "in"
        ? `This hire was not due to start until ${earliestStart}. Check the delivery date.`
        : `This hire did not start until ${earliestStart}. Check the date.`;
    }
    if (direction === "in" && movementDate > earliestStart) {
      return "Arrived after the hire was due to start. The return deadline stays as ordered — extend the hire if the period should move.";
    }
    return null;
  })();

  const tagNotice = active
    .filter((l) => tagCount(l.assetTags) > 0 && tagCount(l.assetTags) !== num(l.quantity))
    .map((l) => `${l.itemName}: ${num(l.quantity)} units, ${tagCount(l.assetTags)} asset tag${tagCount(l.assetTags) === 1 ? "" : "s"}`);

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!movementDate) errs.movementDate = mode.dateMissing;
    // A record that moved nothing is not worth keeping — and it would move no hire either.
    if (totalMoved <= 0) errs.lines = mode.nothingEntered;
    for (const l of lines) {
      const moved = num(l.quantity);
      const damaged = num(l.damaged);
      if (!Number.isFinite(moved) || moved < 0 || !Number.isInteger(moved)) {
        errs.lines = `${l.itemName}: enter a whole number of units.`;
        break;
      }
      // The same cap the server re-checks against the live order — stated here so it is not a round
      // trip to find out.
      if (moved > l.remainder) {
        errs.lines = `${l.itemName}: ${mode.overLine(l.remainder).toLowerCase()}`;
        break;
      }
      if (mode.damagedColumn && (!Number.isFinite(damaged) || damaged < 0 || !Number.isInteger(damaged))) {
        errs.lines = `${l.itemName}: damaged must be a whole number of units.`;
        break;
      }
      if (mode.damagedColumn && damaged > moved) {
        errs.lines = `${l.itemName}: damaged can't be more than the quantity on this line.`;
        break;
      }
    }
    // Damage recorded on a line, with the header still saying the movement was clean, is two answers to
    // one question — and the header is what anyone scanning the list will read.
    if (mode.damagedColumn) {
      if (!condition) errs.condition = mode.conditionMissing;
      else if (totalDamaged > 0 && condition !== "damaged") {
        errs.condition = "Some units are marked damaged — set the condition to Damaged.";
      }
    }
    // A damage claim with nothing describing it is unusable later — the flag is what somebody scans
    // for, the words are what the dispute turns on. The server refuses it too.
    // The server asks for 3 characters, not merely "something" — matched here so "ok" is refused on
    // the screen rather than coming back as a bare 400 after the save has been attempted.
    if (condition === "damaged" && conditionNotes.trim().length < 3) {
      errs.conditionNotes = direction === "damage" ? mode.conditionMissing : "Describe the damage.";
    }
    return errs;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // `po` is what the form was drawn from; the button only exists once it has loaded, and the guard is
    // what lets the payload carry the resolved id rather than the route's code.
    if (saving || !po) return;
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      pushToast("Please fix the highlighted fields.", "alert");
      focusFirstInvalid();
      return;
    }
    setSaving(true);
    try {
      // The LOADED order's id, never the route parameter: this screen is reached as
      // /rentals/receive/PO-0063, so `poId` is usually a purchase-order CODE. The read resolves either,
      // the write takes an ObjectId — sending the code got a flat "Invalid purchase order id."
      const purchaseOrderId = po.id;
      const tagsOf = (l: LineState) =>
        // Split on commas AND newlines: a tag sheet gets pasted as often as it gets typed.
        l.assetTags.trim() ? { assetTags: l.assetTags.split(/[,\n]/).map((t) => t.trim()).filter(Boolean) } : {};
      const lineNotes = (l: LineState) => (l.notes.trim() ? { notes: l.notes.trim() } : {});

      const receipt = await (direction === "in"
        ? rentalService.createHireDelivery({
            purchaseOrderId,
            deliveryDate: movementDate,
            ...(party.trim() ? { carrier: party.trim() } : {}),
            ...(noteRef.trim() ? { deliveryNoteRef: noteRef.trim() } : {}),
            ...(condition ? { condition } : {}),
            ...(conditionNotes.trim() ? { conditionNotes: conditionNotes.trim() } : {}),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            lines: lines.map((l) => ({
              purchaseOrderRentalLineId: l.purchaseOrderRentalLineId,
              receivedQuantity: num(l.quantity),
              ...(num(l.damaged) > 0 ? { damagedQuantity: num(l.damaged) } : {}),
              ...tagsOf(l),
              ...lineNotes(l),
            })),
          })
        : direction === "out"
          ? rentalService.createHireReturn({
              purchaseOrderId,
              returnDate: movementDate,
              ...(party.trim() ? { collectedBy: party.trim() } : {}),
              ...(noteRef.trim() ? { returnNoteRef: noteRef.trim() } : {}),
              ...(condition ? { condition } : {}),
              ...(conditionNotes.trim() ? { conditionNotes: conditionNotes.trim() } : {}),
              ...(notes.trim() ? { notes: notes.trim() } : {}),
              ...(damageChargeRef.trim() ? { damageChargeRef: damageChargeRef.trim() } : {}),
              lines: lines.map((l) => ({
                purchaseOrderRentalLineId: l.purchaseOrderRentalLineId,
                returnedQuantity: num(l.quantity),
                ...(num(l.damaged) > 0 ? { damagedQuantity: num(l.damaged) } : {}),
                // Omitted entirely when the box is blank — "no quote yet" is stored as nothing, not
                // as zero, and the server refuses a charge on a line with no damage on it.
                ...(num(l.damaged) > 0 && money(l.damageCharge) !== undefined
                  ? { damageCharge: money(l.damageCharge) }
                  : {}),
                ...tagsOf(l),
                ...lineNotes(l),
              })),
            })
          : rentalService.reportHireDamage({
              purchaseOrderId,
              reportedDate: movementDate,
              conditionNotes: conditionNotes.trim(),
              ...(notes.trim() ? { notes: notes.trim() } : {}),
              ...(damageChargeRef.trim() ? { damageChargeRef: damageChargeRef.trim() } : {}),
              lines: lines
                .filter((l) => num(l.quantity) > 0)
                .map((l) => ({
                  purchaseOrderRentalLineId: l.purchaseOrderRentalLineId,
                  damagedQuantity: num(l.quantity),
                  ...(money(l.damageCharge) !== undefined ? { damageCharge: money(l.damageCharge) } : {}),
                  ...tagsOf(l),
                  ...lineNotes(l),
                })),
            }));
      setSaved(true);

      // The movement is RECORDED at this point; the photos are evidence hanging off it. A failed upload
      // must not read as a failed save — it is reported on its own and the quantities stand, because
      // re-submitting the form would try to move the same units twice.
      const failures: string[] = [];
      for (const p of photos) {
        try {
          await uploadDirect({ purpose: "hire_delivery_photo", file: p.file, targetId: receipt.id });
        } catch (e) {
          // The REASON, kept. A 403, a full record and a storage outage are three different problems
          // with three different answers, and a bare count made them indistinguishable — which is how
          // a permission bug survived: it looked exactly like a flaky network.
          failures.push(`${p.file.name}: ${e instanceof Error ? e.message : "upload failed"}`);
        }
      }
      if (failures.length > 0) console.error(`${receipt.code} photo uploads failed —`, failures);
      pushToast(
        failures.length > 0
          ? // NOT "add them from the order": there is no add-photo control there, only a remove. The
            // honest instruction is the one that actually recovers the evidence.
            `${receipt.code} recorded, but ${failures.length} photo${failures.length === 1 ? "" : "s"} did not upload (${failures[0]}). Photograph again and record a damage report against this hire.`
          : `${receipt.code} recorded.`,
        failures.length > 0 ? "alert" : "success",
      );
      // Stay put when evidence was lost, so the person can read what failed instead of watching it
      // scroll past in a toast. `saving` deliberately stays true: the record IS saved, and re-enabling
      // the button would offer to save it a second time — which is a worse outcome than a lost photo.
      if (failures.length === 0) {
        router.replace(`/dashboard/purchase-orders/${po.code ?? poId}`);
      } else {
        setErrors({
          form: `${receipt.code} was recorded. ${failures.length} photo${failures.length === 1 ? "" : "s"} did not upload — ${failures.join("; ")}. The record is saved; photograph the equipment again and file a damage report against this hire if the evidence still matters.`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save that record.";
      setErrors({ form: msg });
      pushToast(msg, "alert");
      setSaving(false);
    }
  };

  // The SAME loading and failure states every other form page in the app shows — a page that loads
  // differently reads as a different app, and two bare grey bars said nothing about what was coming.
  if (loadError) return <FormError message={loadError} />;
  if (!po) return <FormPageSkeleton />;

  const showConditionNotes = condition === "damaged";

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <FormPageHeader
        title={mode.title}
        subtitle={`${po.code} · ${po.supplierName ?? "—"}`}
        onBack={() => router.back()}
        actions={
          <>
            <button type="button" onClick={() => router.back()} className={ghostBtn}>
              Cancel
            </button>
            {/* Disabled with no lines: `validate` sets an error whose only renderer lives INSIDE the
                non-empty branch, so pressing it toasted "fix the highlighted fields" with nothing
                highlighted and nothing for focusFirstInvalid to find. */}
            <button type="submit" disabled={saving || lines.length === 0} className={primaryBtn}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}
              {mode.submitLabel}
            </button>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <FormSection title={mode.eventTitle} description={mode.eventDescription}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="min-w-0">
                <label className={labelCls}>
                  {mode.dateLabel}
                  <RequiredMark />
                </label>
                {/* Not always today: paperwork catches up, and the hire's clock has to run from when the
                    equipment actually moved. No `max` — a future date is a typo the notice explains
                    better than a blocked field can. */}
                <input
                  type="date"
                  className={inputCls}
                  value={movementDate}
                  aria-invalid={Boolean(errors.movementDate)}
                  onChange={(e) => {
                    setMovementDate(e.target.value);
                    touch();
                  }}
                />
                <FieldError id="err-movementDate" message={errors.movementDate} />
                {dateNotice ? (
                  <p className="mt-1.5 flex items-start gap-1.5 text-[11px] font-semibold text-[var(--warn,#d97706)]">
                    <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                    {dateNotice}
                  </p>
                ) : (
                  <p className={hintCls}>{mode.dateHint}</p>
                )}
                {plannedArrival && (
                  <p className="mt-1 text-[11px] text-[var(--faint)]">
                    {plannedLabel} {shortDate(plannedArrival)} on the order
                    {movementDate && movementDate !== plannedArrival.slice(0, 10) ? " — record what actually happened." : "."}
                  </p>
                )}
              </div>
              {mode.refLabel && (
                <div className="min-w-0">
                  <label className={labelCls}>{mode.refLabel}</label>
                  <input
                    className={inputCls}
                    value={noteRef}
                    maxLength={60}
                    placeholder={mode.refPlaceholder}
                    onChange={(e) => {
                      setNoteRef(e.target.value);
                      touch();
                    }}
                  />
                  <p className={hintCls}>{mode.refHint}</p>
                </div>
              )}
              {mode.partyLabel && (
                <div className="min-w-0">
                  <label className={labelCls}>{mode.partyLabel}</label>
                  <input
                    className={inputCls}
                    value={party}
                    maxLength={120}
                    placeholder={mode.partyPlaceholder}
                    onChange={(e) => {
                      setParty(e.target.value);
                      touch();
                    }}
                  />
                  <p className={hintCls}>{mode.partyHint}</p>
                </div>
              )}
              {mode.damagedColumn && (
                <div className="min-w-0">
                  <label className={labelCls}>
                    {mode.conditionLabel}
                    <RequiredMark />
                  </label>
                  <Select
                    value={condition}
                    onChange={(v) => {
                      setCondition(v as ReceiptCondition);
                      touch();
                    }}
                    options={CONDITIONS[direction]}
                    placeholder={mode.conditionPlaceholder}
                    ariaLabel={mode.conditionLabel}
                    invalid={Boolean(errors.condition)}
                    required
                  />
                  <FieldError id="err-condition" message={errors.condition} />
                  <p className={hintCls}>{mode.conditionHint}</p>
                </div>
              )}
              {/* Only once there is damage to describe. On a clean movement it is a box with nothing to
                  put in it, and this form is read on a warehouse floor. On a damage report it is the
                  whole point, so it is always there. */}
              {showConditionNotes && (
                <div className="min-w-0 sm:col-span-2">
                  <label className={labelCls}>
                    {mode.damagedColumn ? "Condition notes" : mode.conditionLabel}
                    <RequiredMark />
                  </label>
                  {/* The hire ends in a handover, and every damage dispute is about which side broke it.
                      What is written here is the record. */}
                  <textarea
                    className={inputCls}
                    rows={2}
                    maxLength={2000}
                    value={conditionNotes}
                    aria-invalid={Boolean(errors.conditionNotes)}
                    placeholder="e.g. Left corner scratched, carry strap missing."
                    onChange={(e) => {
                      setConditionNotes(e.target.value);
                      touch();
                    }}
                  />
                  <FieldError id="err-conditionNotes" message={errors.conditionNotes} />
                  <p className={hintCls}>
                    {mode.damagedColumn ? "Anything the supplier should not later charge us for." : mode.conditionHint}
                  </p>
                </div>
              )}
            </div>
          </FormSection>

          <FormSection title={mode.linesTitle} description={mode.linesDescription}>
            {lines.length === 0 ? (
              <p className="py-6 text-center text-sm text-[var(--muted)]">{mode.linesEmpty}</p>
            ) : (
              <div className="space-y-3">
                {lines.map((l, idx) => {
                  const movedNow = num(l.quantity);
                  const over = movedNow > l.remainder;
                  const damagedOver = num(l.damaged) > movedNow;
                  // How many units on THIS line are damaged, whichever leg is being recorded: on a
                  // damage report the quantity IS the damage, on a return it is the subset box.
                  const damagedHere = direction === "damage" ? movedNow : num(l.damaged);
                  return (
                    <div
                      key={l.purchaseOrderRentalLineId}
                      className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-3"
                    >
                      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-sm font-bold text-[var(--ink)]">
                          {l.itemName}
                          {l.baseUnit ? (
                            <span className="ml-1.5 text-[11px] font-normal text-[var(--faint)]">{l.baseUnit}</span>
                          ) : null}
                        </span>
                        <span className="text-[11px] text-[var(--muted)]">
                          {/* "Ordered" is the frame for a delivery and for a collection. On a damage
                              report it is noise — what matters is how much is in our hands. */}
                          {direction === "damage" ? `With us ${l.held}` : `Ordered ${l.ordered}`} ·{" "}
                          {/* "…WITH US", not "…damaged". The line below can read "1 already recorded as
                              damaged ON ARRIVAL", and two damage numbers a line apart read as a
                              contradiction unless each says which damage it counts. They are
                              deliberately separate: arrival damage is the supplier's and is evidenced
                              on their delivery note, this is ours, and adding them would double-count
                              a unit that arrived scratched and was later dropped. The warehouse pane
                              carries the same wording ("Damaged with us"). */}
                          {direction === "in"
                            ? "Already received"
                            : direction === "out"
                              ? "Already returned"
                              : "Already reported with us"}{" "}
                          {l.alreadyMoved} ·{" "}
                          <strong className={over ? "text-[var(--neg)]" : "text-[var(--ink)]"}>
                            {mode.remainderLabel} {l.remainder}
                          </strong>
                        </span>
                      </div>
                      {/* WHICH hire, and where the kit is. An order can carry the same item twice for
                          different periods, and its lines can sit at different places. */}
                      <p className="mb-2.5 text-[11px] text-[var(--faint)]">
                        Hire {shortDate(l.hireStartDate)} → {shortDate(l.hireEndDate)} · {direction === "in" ? "to" : "at"}{" "}
                        {l.destination}
                      </p>
                      {/* WHAT IS ALREADY ON FILE, and whose it is. Both halves, because the person at
                          the handover needs the whole picture to judge the box below — and because
                          naming which is which is the difference between "the supplier sent it broken"
                          and "we broke it", which is the difference between who pays. */}
                      {(() => {
                        const prior = priorDamage[l.purchaseOrderRentalLineId];
                        const showsWithUs = direction === "out" && Boolean(prior?.withUs);
                        if (!prior?.onArrival && !showsWithUs) return null;
                        return (
                          <div className="mb-2.5 space-y-1 text-[11px] font-semibold text-[var(--warn,#d97706)]">
                            {prior.onArrival && (
                              <p className="flex items-start gap-1.5">
                                <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                                <span>
                                  {prior.onArrival.units} already recorded as damaged ON ARRIVAL (
                                  {prior.onArrival.codes.join(", ")}) — the supplier&apos;s.{" "}
                                  {/* The guidance sits WITH the fact it qualifies rather than in a line
                                      of its own underneath: three stacked sentences above one number
                                      box is a wall, and the third of them was explaining why the box
                                      is empty — a question nobody asks unless the answer is missing. */}
                                  {direction === "damage"
                                    ? "Report here only what has been damaged since."
                                    : "Record it here only if it went back worse than it arrived."}
                                </span>
                              </p>
                            )}
                            {/* Only on the RETURN leg. The damage form already carries this number in
                                its line header ("Already reported with us N"), and saying it twice on
                                one card is how a warning stops being read. */}
                            {direction === "out" && prior.withUs && (
                              <p className="flex items-start gap-1.5">
                                <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                                <span>
                                  {prior.withUs.units} already reported damaged WITH US (
                                  {prior.withUs.codes.join(", ")}) — ours.
                                </span>
                              </p>
                            )}
                          </div>
                        );
                      })()}
                      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                        <div>
                          <div className="mb-1.5 flex items-center justify-between gap-2">
                            <label className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                              {mode.qtyLabel}
                            </label>
                            {/* The same shortcut the goods-receipt form offers, in the same place. */}
                            {l.remainder > 0 && movedNow !== l.remainder && (
                              <button
                                type="button"
                                onClick={() => setLine(idx, { quantity: String(l.remainder) })}
                                className="text-[11px] font-bold text-[var(--accent)] hover:underline"
                              >
                                All {l.remainder}
                              </button>
                            )}
                          </div>
                          <NumberInput
                            className={inputCls}
                            clamp
                            min="0"
                            max={String(l.remainder)}
                            step="1"
                            value={l.quantity}
                            placeholder={direction === "damage" ? "0" : undefined}
                            aria-invalid={over}
                            onChange={(e) => setLine(idx, { quantity: e.target.value })}
                          />
                          {over && (
                            <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{mode.overLine(l.remainder)}</p>
                          )}
                        </div>
                        {mode.damagedColumn && (
                          <div>
                            <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                              Of those, damaged
                            </label>
                            {/* Bounded by what arrived on THIS line — "of those, damaged" cannot
                                exceed "those". It had no max at all, so the spinner ran free and
                                534345 against one ordered unit was accepted and then argued with. */}
                            <NumberInput
                              className={inputCls}
                              clamp
                              min="0"
                              max={l.quantity === "" ? undefined : l.quantity}
                              step="1"
                              value={l.damaged}
                              placeholder="0"
                              aria-invalid={damagedOver}
                              onChange={(e) => setLine(idx, { damaged: e.target.value })}
                            />
                            {damagedOver && (
                              <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">
                                More damaged than the quantity on this line.
                              </p>
                            )}
                          </div>
                        )}
                        {/* WHAT THEY ARE CHARGING US, beside the damage it prices.
                            Never on the ARRIVAL leg — damage that came with the kit is the supplier's
                            own fault and already evidenced against them, so a charge there would be us
                            booking a payment for their mistake. The service refuses it outright.
                            Shown only once this line actually carries damage, and OPTIONAL even then:
                            the fault is found today and the quote comes next week, so the usual path
                            is to leave it blank and record it later from the order's movement panel.
                            An empty box means "nothing quoted yet", which is not the same as £0 and is
                            stored as a different value. */}
                        {direction !== "in" && damagedHere > 0 && (
                          <div>
                            <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                              Damage charge (£)
                            </label>
                            <NumberInput
                              className={inputCls}
                              min="0"
                              step="0.01"
                              value={l.damageCharge}
                              placeholder="Later, if not known"
                              onChange={(e) => setLine(idx, { damageCharge: e.target.value })}
                            />
                          </div>
                        )}
                        <div className={mode.damagedColumn ? "col-span-2" : "col-span-1 xl:col-span-3"}>
                          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                            Supplier asset / serial numbers
                          </label>
                          {/* Their tags, not ours: the kit is theirs, and these identify the exact units.
                              Comma separated — they come off a printed sheet. */}
                          <input
                            className={inputCls}
                            value={l.assetTags}
                            placeholder="e.g. A001, A002"
                            onChange={(e) => setLine(idx, { assetTags: e.target.value })}
                          />
                        </div>
                        <div className="col-span-2 xl:col-span-4">
                          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                            Line notes
                          </label>
                          <input
                            className={inputCls}
                            value={l.notes}
                            maxLength={1000}
                            placeholder="Anything specific to this item on this record."
                            onChange={(e) => setLine(idx, { notes: e.target.value })}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
                {/* The supplier's own reference for what they are charging. Appears only once a
                    figure has been entered above: on the ordinary return — no damage, no charge — it
                    would be one more empty box between the person and the Save button. */}
                {direction !== "in" && lines.some((l) => l.damageCharge.trim() !== "") && (
                  <div>
                    <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                      Supplier&apos;s quote / invoice reference
                    </label>
                    <input
                      className={inputCls}
                      value={damageChargeRef}
                      maxLength={60}
                      placeholder="Their document number for the damage charge"
                      onChange={(e) => setDamageChargeRef(e.target.value)}
                    />
                  </div>
                )}
                <FieldError id="err-lines" message={errors.lines} />
                {/* Not an error: a tag sheet can be short. Worth saying out loud, not worth refusing
                    the record over. */}
                {tagNotice.length > 0 && (
                  <p className="flex items-start gap-1.5 text-[11px] font-semibold text-[var(--warn,#d97706)]">
                    <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                    <span>
                      Fewer asset tags than units — {tagNotice.join("; ")}. These are what identify the
                      exact units at collection.
                    </span>
                  </p>
                )}
                {/* NO "these lines go to different places" warning here, deliberately.
                    It assumed a line's delivery address is a separate physical drop that deserves its
                    own record. It is not: the address is the instruction printed on the supplier's
                    ORDER, and every one of these records is filed against the order's WAREHOUSE
                    (`warehouseId` on the note) because the warehouse is where hired kit is booked in
                    and stored. Splitting a record per address would split one booking-in into several
                    that never happened. The addresses still matter — each line prints its own above,
                    and the supplier reads them off the order — they just do not divide this record. */}
              </div>
            )}
          </FormSection>

          {/* CONDITION EVIDENCE. The one thing on this screen that cannot be added later: the argument
              at the end of a hire is always about which side broke it, and nobody can photograph a
              moment after it has passed. */}
          <FormSection title={mode.photosTitle} description={mode.photosDescription}>
            <div className="space-y-3">
              {/* The SAME picker and list the goods receipt uses — a row per file, click to enlarge, remove.
                  A row of file names is not a photograph: the whole point of condition evidence is that
                  somebody can look at it, and they should be able to look at it before it is filed. */}
              <DocPicker
                count={photos.length}
                totalBytes={photos.reduce((sum, p) => sum + p.file.size, 0)}
                limits={PHOTO_LIMITS}
                accept={PHOTO_ACCEPT}
                label="Add photos"
                multiple
                hint={`${mode.photosHint} Max 10 MB each · ${MAX_PHOTOS} photos · 40 MB total.`}
                onPick={(doc) => {
                  setPhotos((prev) => [
                    ...prev,
                    {
                      key: crypto.randomUUID(),
                      file: doc.file,
                      fileType: doc.fileType,
                      previewUrl: URL.createObjectURL(doc.file),
                    },
                  ]);
                  touch();
                }}
              />
              <AttachmentList
                // Staged picks, not stored files — re-picking one costs nothing.
                confirmRemove={false}
                items={photos.map((p) => ({
                  id: p.key,
                  fileName: p.file.name,
                  fileType: p.fileType,
                  fileSizeBytes: p.file.size,
                  src: p.previewUrl,
                }))}
                emptyLabel="No condition photos yet."
                onRemove={(id) => {
                  setPhotos((prev) => {
                    const gone = prev.find((p) => p.key === id);
                    if (gone) URL.revokeObjectURL(gone.previewUrl);
                    return prev.filter((p) => p.key !== id);
                  });
                  touch();
                }}
              />
              {condition === "damaged" && photos.length === 0 && (
                <p className="flex items-start gap-1.5 text-[11px] font-semibold text-[var(--warn,#d97706)]">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                  {/* Not required — a phone can be flat, a yard can have no signal. But damage recorded
                      with no picture is a claim with nothing behind it, and this is the only moment the
                      picture can be taken. */}
                  Damage recorded with no photo. This is the only chance to capture it.
                </p>
              )}
            </div>
          </FormSection>

          <FormSection title="Notes" description="Internal context about this record.">
            <textarea
              className={inputCls}
              rows={3}
              maxLength={2000}
              value={notes}
              placeholder="Anything the next person handling this hire should know."
              onChange={(e) => {
                setNotes(e.target.value);
                touch();
              }}
            />
          </FormSection>

          {errors.form && <FieldError id="err-form" message={errors.form} />}
        </div>

        <aside className="space-y-6 xl:sticky xl:top-6 xl:self-start">
          <FormAsideCard title={mode.asideTitle}>
            <div className="space-y-2.5 text-sm">
              {/* No "Purchase order" or "Supplier" row: the page header two inches above already reads
                  "PO-0063 · kansha", and a summary that repeats the title says nothing. */}
              {/* WHERE THIS RECORD IS FILED — the order's warehouse, for every direction, because that
                  is what the note stores and whose queue this came off. It used to summarise the
                  lines' delivery ADDRESSES ("2 places"), which are the supplier's delivery instruction
                  on the order and not where the booking-in happens. Each line still shows its own
                  address above; this row answers a different question. */}
              <SummaryRow label="Recorded at">{po.warehouse?.name ?? "—"}</SummaryRow>
              <SummaryRow label="Lines on this record">{active.length}</SummaryRow>
              <SummaryRow label={mode.unitsLabel}>{totalMoved}</SummaryRow>
              {/* What the hire becomes the moment this is recorded — the date everything afterwards
                  counts down to. Only on the way IN: on the way back the deadline is what stops. */}
              {direction === "in" && returnsBy && <SummaryRow label="Returns by">{shortDate(returnsBy)}</SummaryRow>}
              {mode.damagedColumn && totalDamaged > 0 && (
                <SummaryRow label="Of those, damaged" valueClassName="font-extrabold text-[var(--neg)]">
                  {totalDamaged}
                </SummaryRow>
              )}
            </div>
            <p className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 text-[11px] text-[var(--muted)]">
              {mode.asideNote}
            </p>
            <p className="mt-2 text-[11px] text-[var(--faint)]">Recording as {me}</p>
          </FormAsideCard>
        </aside>
      </div>
    </form>
  );
}
