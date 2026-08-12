import { describe, expect, it } from "vitest";

import {
  approveVanStockRequestSchema,
  declineVanStockRequestSchema,
  closeShortSchema,
  createVanStockRequestSchema,
  fulfilVanStockRequestSchema,
  uploadImageSchema,
  walkInSchema,
} from "./van-stock-request.validation.js";

const oid = "a".repeat(24);
const WH_A = "b".repeat(24);
const WH_B = "c".repeat(24);
// A restock line now names the warehouse it is collected FROM; a return line never does.
const line = { irmItemId: oid, itemName: "Cable Ties", qty: 100, warehouseId: WH_A };
const returnLine = { irmItemId: oid, itemName: "Cable Ties", qty: 100 };

describe("createVanStockRequestSchema", () => {
  it("accepts a restock whose every line names a collection warehouse", () => {
    expect(createVanStockRequestSchema.safeParse({ type: "restock", reason: "van low", lines: [line] }).success).toBe(true);
  });

  // The whole point of the per-line model: the engineer decides where each item comes from, seeing
  // that warehouse's live stock, instead of naming one place and having a reviewer split it later.
  it("accepts lines collected from DIFFERENT warehouses (a split the engineer chose)", () => {
    const r = createVanStockRequestSchema.safeParse({
      type: "restock",
      reason: "van low",
      lines: [line, { irmItemId: "d".repeat(24), itemName: "Fibre", qty: 2, warehouseId: WH_B }],
    });
    expect(r.success).toBe(true);
  });

  it("REJECTS a restock line with no warehouse, and names the line", () => {
    const r = createVanStockRequestSchema.safeParse({ type: "restock", reason: "van low", lines: [returnLine] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.join(".") === "lines.0.warehouseId")).toBe(true);
  });

  it("rejects a malformed line warehouse id — required is not unvalidated", () => {
    expect(createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", lines: [{ ...line, warehouseId: "nope" }] }).success).toBe(false);
  });

  // Derived server-side from the lines. Accepting it would let a caller route the request to a
  // warehouse none of its stock is actually coming from.
  it("rejects a client-supplied preferredWarehouseId on a restock", () => {
    expect(createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", preferredWarehouseId: WH_A, lines: [line] }).success).toBe(false);
  });

  it("rejects a restock carrying a final warehouseId", () => {
    expect(createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", warehouseId: oid, lines: [line] }).success).toBe(false);
  });

  it("requires warehouseId on a return and rejects preferredWarehouseId", () => {
    expect(createVanStockRequestSchema.safeParse({ type: "return", reason: "excess", lines: [returnLine] }).success).toBe(false);
    expect(createVanStockRequestSchema.safeParse({ type: "return", reason: "excess", warehouseId: oid, lines: [returnLine] }).success).toBe(true);
    expect(createVanStockRequestSchema.safeParse({ type: "return", reason: "excess", warehouseId: oid, preferredWarehouseId: oid, lines: [returnLine] }).success).toBe(false);
  });

  // A return goes to ONE place the engineer drives to — a per-line source there would be meaningless
  // and would leave lines pointing at warehouses the stock never reaches.
  it("rejects a per-line warehouse on a return", () => {
    const r = createVanStockRequestSchema.safeParse({ type: "return", reason: "excess", warehouseId: oid, lines: [line] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.join(".") === "lines.0.warehouseId")).toBe(true);
  });

  it("rejects duplicate items across lines", () => {
    expect(createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", lines: [line, { ...line, qty: 5 }] }).success).toBe(false);
  });

  it("defaults priority to normal and rejects unknown priorities", () => {
    const ok = createVanStockRequestSchema.parse({ type: "restock", reason: "x", lines: [line] });
    expect(ok.priority).toBe("normal");
    expect(createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", priority: "asap", lines: [line] }).success).toBe(false);
  });

  it("rejects qty < 1 and non-integers", () => {
    expect(createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", lines: [{ ...line, qty: 0 }] }).success).toBe(false);
    expect(createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", lines: [{ ...line, qty: 1.5 }] }).success).toBe(false);
  });
});

// A decline now refuses only the ACTING warehouse's lines, so it must name that warehouse — the same
// shape closeShortSchema has always had. Without it the service fell back to the actor's permission
// scope, and an unrestricted actor (a super admin has no warehouse scope at all) refused every
// warehouse's lines from whichever tab they happened to be in.
describe("declineVanStockRequestSchema", () => {
  it("requires the warehouse being declined FROM", () => {
    expect(declineVanStockRequestSchema.safeParse({ decisionNote: "no stock" }).success).toBe(false);
    expect(declineVanStockRequestSchema.safeParse({ warehouseId: oid, decisionNote: "no stock" }).success).toBe(true);
  });
  it("still requires a reason", () => {
    expect(declineVanStockRequestSchema.safeParse({ warehouseId: oid, decisionNote: "" }).success).toBe(false);
  });
});

describe("approveVanStockRequestSchema", () => {
  it("requires the final warehouse", () => {
    expect(approveVanStockRequestSchema.safeParse({}).success).toBe(false);
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid }).success).toBe(true);
  });
  it("accepts per-line trims with qty ≥ 1", () => {
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: 60 }] }).success).toBe(true);
  });
  it("accepts approvedQty 0 (exclude a line)", () => {
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: 0 }] }).success).toBe(true);
  });
  it("rejects a negative approvedQty", () => {
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: -1 }] }).success).toBe(false);
  });
  it("accepts an optional per-line sourceWarehouseId", () => {
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: 2, sourceWarehouseId: oid }] }).success).toBe(true);
  });
  it("rejects a malformed sourceWarehouseId", () => {
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: 2, sourceWarehouseId: "nope" }] }).success).toBe(false);
  });
});

describe("fulfilVanStockRequestSchema", () => {
  it("requires photo + reason on damaged entries", () => {
    const good = { lineId: oid, qty: 5, condition: "good", scannedCode: "IRM-0002" };
    const damagedBad = { lineId: oid, qty: 5, condition: "damaged", scannedCode: "IRM-0002" };
    const damagedOk = { ...damagedBad, damagePhotoUrl: "https://res.cloudinary.com/x/d.jpg", damageReason: "crushed" };
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: oid, entries: [good] }).success).toBe(true);
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: oid, entries: [damagedBad] }).success).toBe(false);
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: oid, entries: [damagedOk] }).success).toBe(true);
  });
  // The issuing warehouse (the tab) is required — the service uses it to enforce a line is only posted
  // out of the warehouse it's sourced to (even for an admin).
  it("requires a warehouseId", () => {
    expect(fulfilVanStockRequestSchema.safeParse({ entries: [{ lineId: oid, qty: 1, condition: "good", scannedCode: "IRM-0002" }] }).success).toBe(false);
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: "nope", entries: [{ lineId: oid, qty: 1, condition: "good", scannedCode: "IRM-0002" }] }).success).toBe(false);
  });
  it("rejects an empty posting", () => {
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: oid, entries: [] }).success).toBe(false);
  });
  // Scan-only posting (mirrors Goods Management): an entry with no scannedCode is stock nobody read off
  // the item, so the API must refuse it — the UI having no manual-add button is not the enforcement.
  it("rejects an entry with no scannedCode", () => {
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: oid, entries: [{ lineId: oid, qty: 1, condition: "good" }] }).success).toBe(false);
  });
  it("rejects a blank/whitespace scannedCode", () => {
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: oid, entries: [{ lineId: oid, qty: 1, condition: "good", scannedCode: "   " }] }).success).toBe(false);
  });
  // An item with no printed barcode is still scannable by its IRM code (lookup resolves code|barcode|sku).
  it("accepts an IRM code as the scanned value", () => {
    expect(fulfilVanStockRequestSchema.safeParse({ warehouseId: oid, entries: [{ lineId: oid, qty: 1, condition: "good", scannedCode: "IRM-0002" }] }).success).toBe(true);
  });
});

describe("closeShortSchema", () => {
  it("requires a note AND the warehouseId being closed short from", () => {
    expect(closeShortSchema.safeParse({}).success).toBe(false);
    expect(closeShortSchema.safeParse({ warehouseId: oid, note: "supplier discontinued" }).success).toBe(true);
    // note without warehouseId is rejected — the service uses warehouseId to scope the write-off to one tab.
    expect(closeShortSchema.safeParse({ note: "supplier discontinued" }).success).toBe(false);
    expect(closeShortSchema.safeParse({ warehouseId: "nope", note: "x" }).success).toBe(false);
  });
});

describe("walkInSchema", () => {
  it("requires engineer + warehouse + lines", () => {
    expect(walkInSchema.safeParse({ engineerId: oid, warehouseId: oid, reason: "counter", lines: [line] }).success).toBe(true);
    expect(walkInSchema.safeParse({ engineerId: oid, reason: "counter", lines: [line] }).success).toBe(false);
  });
  it("rejects duplicate items across lines", () => {
    expect(walkInSchema.safeParse({ engineerId: oid, warehouseId: oid, reason: "counter", lines: [line, { ...line, qty: 5 }] }).success).toBe(false);
  });
});
// ── Attachment upload contract ──────────────────────────────────────────────────────────────────
//
// Fixtures carry REAL leading bytes rather than a placeholder under a chosen label. This schema judges
// the declared media type only, so a bare label would satisfy it — which is the weakness being closed.
const bytesOf = (signature: number[], pad = 40) =>
  Buffer.concat([Buffer.from(signature), Buffer.alloc(pad, 0x41)]).toString("base64");
const PNG = bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = bytesOf([0xff, 0xd8, 0xff, 0xe0]);
const GIF = bytesOf([...Buffer.from("GIF89a")]);
const PDF = bytesOf([0x25, 0x50, 0x44, 0x46, 0x2d]);
const EXE = bytesOf([0x4d, 0x5a, 0x90, 0x00]); // a Windows executable
const ZIP = bytesOf([0x50, 0x4b, 0x03, 0x04]);
const uri = (mediaType: string, payload: string) => `data:${mediaType};base64,${payload}`;
const MAX_CHARS = 3 * 1024 * 1024;

// `application/octet-stream` is what a browser emits when it knows nothing about a file. Accepting it
// meant this endpoint accepted ANY payload under that one label — an executable, an archive — while
// the picker only ever offers `image/*`.
describe("uploadImageSchema — van-stock evidence", () => {
  const parse = (v: string) => uploadImageSchema.safeParse({ image: v });

  it("rejects application/octet-stream", () => {
    expect(parse(uri("application/octet-stream", PNG)).success).toBe(false);
  });

  it.each([
    ["an executable", EXE],
    ["a ZIP archive", ZIP],
  ])("rejects %s declared as octet-stream", (_l, payload) => {
    expect(parse(uri("application/octet-stream", payload)).success).toBe(false);
  });

  it.each([
    ["PNG", "image/png", PNG],
    ["JPEG", "image/jpeg", JPG],
    ["GIF", "image/gif", GIF],
    ["WEBP", "image/webp", GIF],
    ["SVG", "image/svg+xml", GIF],
    ["PDF", "application/pdf", PDF],
  ])("still accepts %s", (_l, mediaType, payload) => {
    expect(parse(uri(mediaType, payload)).success).toBe(true);
  });

  it("keeps the ~2 MB ceiling", () => {
    expect(parse(uri("image/png", "A".repeat(MAX_CHARS))).success).toBe(false);
  });

  it("still rejects a plain URL", () => {
    expect(parse("https://cdn.example.com/photo.png").success).toBe(false);
  });

  // Anchored to `;base64,`. A percent-encoded data URI is a different encoding, not a smaller one:
  // it used to pass this regex and fail later inside Cloudinary, surfacing an error from the wrong
  // layer with a message about nothing the caller did.
  it.each([
    ["a percent-encoded data URI", "data:image/png,hello-world"],
    ["a data URI with no encoding declared", "data:image/png,"],
    ["a charset instead of base64", "data:image/png;charset=utf-8,abc"],
  ])("rejects %s", (_l, v) => {
    expect(parse(v).success).toBe(false);
  });
});
