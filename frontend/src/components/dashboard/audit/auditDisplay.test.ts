import { describe, expect, it } from "vitest";

import { actionLabel, actionTone, changeLabels, manualSendDetails } from "./auditDisplay";

// ── The two doors onto `sent` must read as one event ───────────────────────────────────────────
//
// "Send to supplier" and "Mark as sent" are the SAME lifecycle transition — the order is issued —
// and the only difference is whether Senthra carried the document. `purchase_order.sent_manually`
// matched nothing in VERB_TONE and no `_…` suffix rule, so it fell through to neutral grey and sat
// in the trail beside an amber `purchase_order.sent` looking like a different kind of thing.
describe("actionTone — purchase order issue", () => {
  it("gives both doors onto `sent` the same tone", () => {
    expect(actionTone("purchase_order.sent_manually")).toBe(actionTone("purchase_order.sent"));
  });

  it("tones the issue transition as an update, not a neutral", () => {
    expect(actionTone("purchase_order.sent")).toBe("update");
    expect(actionTone("purchase_order.sent_manually")).toBe("update");
  });

  // The failure mode was silence: nothing errored, the chip was simply grey. Assert the fall-through
  // did not happen rather than only asserting the value, so a future rename that reintroduces it is
  // named for what it is.
  it("does not let either fall through to the neutral default", () => {
    for (const action of ["purchase_order.sent", "purchase_order.sent_manually"]) {
      expect(actionTone(action), action).not.toBe("neutral");
    }
  });

  // The surrounding PO lifecycle, unchanged — so the fix cannot have been made by loosening a suffix
  // rule that swept these up with it.
  it("leaves the rest of the PO lifecycle alone", () => {
    expect(actionTone("purchase_order.cancelled")).toBe("delete");
    expect(actionTone("purchase_order.closed")).toBe("neutral");
    expect(actionTone("purchase_order.received")).toBe("create");
  });

  // The label is derived from the action name, and the name is deliberately unchanged.
  it("reads the manual door as its own line in the trail", () => {
    expect(actionLabel("purchase_order.sent_manually")).toBe("Purchase Order · Sent Manually");
    expect(actionLabel("purchase_order.sent")).toBe("Purchase Order · Sent");
  });
});

// ── The channel and note the Mark-as-sent dialog collects ──────────────────────────────────────
//
// The dialog tells the user both are "recorded on the audit trail", and they are — but the PO's own
// Audit tab rendered neither, because it only ever read `metadata.changes`. They were visible only
// as raw JSON in the global audit drawer, which is not where somebody looking at the order will go.
describe("manualSendDetails", () => {
  const ACTION = "purchase_order.sent_manually";

  it("shows both when both were given", () => {
    expect(manualSendDetails(ACTION, { channel: "whatsapp", note: "Sent to Robert on WhatsApp" })).toEqual([
      "Method: WhatsApp",
      "Note: Sent to Robert on WhatsApp",
    ]);
  });

  // Both fields are optional on the server, so all four combinations are real. Each renders exactly
  // what it has — never a "Method: —" placeholder for something the user chose not to say.
  it("shows the channel alone", () => {
    expect(manualSendDetails(ACTION, { channel: "printed" })).toEqual(["Method: Printed / hand-delivered"]);
  });

  it("shows the note alone", () => {
    expect(manualSendDetails(ACTION, { note: "Handed over on site" })).toEqual(["Note: Handed over on site"]);
  });

  it("shows nothing when neither was given", () => {
    expect(manualSendDetails(ACTION, {})).toEqual([]);
    expect(manualSendDetails(ACTION, undefined)).toEqual([]);
    expect(manualSendDetails(ACTION, null)).toEqual([]);
  });

  // "email" means the user sent it from their own mailbox. The label has to say so, because the one
  // thing this whole flow must not imply is that Senthra emailed anything.
  it("spells out that the email channel was the user's own", () => {
    expect(manualSendDetails(ACTION, { channel: "email" })).toEqual(["Method: Email"]);
  });

  it.each([
    ["email", "Email"],
    ["whatsapp", "WhatsApp"],
    ["printed", "Printed / hand-delivered"],
    ["phone", "Phone"],
    ["other", "Other"],
  ])("labels the %s channel", (channel, label) => {
    expect(manualSendDetails(ACTION, { channel })).toEqual([`Method: ${label}`]);
  });

  // A newer server knowing a channel this build does not must not silently drop it.
  it("shows an unrecognised channel verbatim rather than hiding it", () => {
    expect(manualSendDetails(ACTION, { channel: "courier" })).toEqual(["Method: courier"]);
  });

  // ── Containment ──
  //
  // Keyed on the ACTION, not on the metadata shape. This is what stops it becoming a general
  // metadata dumper: an unrelated entry that happens to carry a `note` renders nothing here and
  // keeps going to the audit drawer, where raw metadata belongs.
  it("renders nothing for any other action, however similar the metadata", () => {
    for (const action of ["purchase_order.sent", "purchase_order.cancelled", "user.profile_updated"]) {
      expect(manualSendDetails(action, { channel: "whatsapp", note: "secret" }), action).toEqual([]);
    }
  });

  it("ignores every field but channel and note", () => {
    const out = manualSendDetails(ACTION, {
      channel: "phone",
      note: "Called the yard",
      supplierEmail: "buyer@supplier.example",
      internalReference: "do-not-show",
    });
    expect(out).toEqual(["Method: Phone", "Note: Called the yard"]);
  });

  // The server normalises blank to absent, but a row written before it did must not render a bare
  // "Note:" with nothing after it.
  it("treats a blank or whitespace note as absent", () => {
    expect(manualSendDetails(ACTION, { note: "" })).toEqual([]);
    expect(manualSendDetails(ACTION, { note: "   " })).toEqual([]);
    expect(manualSendDetails(ACTION, { channel: "", note: "" })).toEqual([]);
  });

  it("trims a note that was stored with surrounding whitespace", () => {
    expect(manualSendDetails(ACTION, { note: "  on site  " })).toEqual(["Note: on site"]);
  });

  // Metadata is typed `unknown` and comes off the wire. Nothing here may throw on a shape it did
  // not expect.
  it("survives non-string values without throwing", () => {
    expect(manualSendDetails(ACTION, { channel: 7, note: { nested: true } })).toEqual([]);
    expect(manualSendDetails(ACTION, "not an object")).toEqual([]);
    expect(manualSendDetails(ACTION, [1, 2, 3])).toEqual([]);
  });
});

// The two extractors the PO audit row concatenates. They answer different metadata shapes and must
// not start answering each other's — a `sent_manually` entry has no `changes`, and an edit has no
// `channel`.
describe("changeLabels and manualSendDetails do not overlap", () => {
  it("changeLabels ignores manual-send metadata", () => {
    expect(changeLabels({ channel: "whatsapp", note: "x" })).toEqual([]);
  });

  it("manualSendDetails ignores an edit's change list", () => {
    expect(manualSendDetails("purchase_order.sent_manually", { changes: [{ label: "Quantity 1 → 2" }] })).toEqual([]);
  });
});
