// ── What each upload is allowed to be ──────────────────────────────────────────────────────────
//
// One entry per upload contract. Everything a signature commits to — who may ask for it, where the
// asset lands, what it may contain, how big it may be — is decided HERE and signed, so none of it is
// a value the browser gets to choose.
//
// The catalog exists because direct upload moves the decision earlier. In the old flow the file came
// through this server and could be inspected on the way past; now the only chance to constrain it is
// before it is sent. A `purpose` is that constraint, named once and re-checked at finalize — so a
// signature obtained for a 2 MB engineer photo cannot be spent attaching a 10 MB document to a
// purchase order.
//
// DELIBERATELY NOT a generic policy engine. It is a table of the nine uploads this app actually has.

/** Where the asset ends up referenced, which decides what finalize does with it. */
export type FinalizeMode =
  // Finalize writes the attachment itself, through the module's existing service — PRF, PO and GRN
  // already have one, with their own permissions, caps, audit and DTO.
  | "attach"
  // Finalize validates and hands the URL back. The record does not exist yet (a job being created, a
  // van-stock request being composed), so the URL sits in the form until the user saves — exactly as
  // it does today. Finalize is the point at which we stop tracking the asset, which means an
  // abandoned FORM still leaks it. That is the existing, separately-deferred gap; direct upload does
  // not widen it, and closing it needs the String[] fields to become rows.
  | "return-url"
  // Like `return-url` in what the browser gets back — a URL for a record that does not exist yet —
  // but the ledger row is KEPT rather than released. That single difference is what closes the
  // abandoned-form leak: the row stays pending, so a form the user never saves is reclaimed by the
  // reaper on its normal pass, while a form that IS saved commits the row into a real attachment.
  //
  // The finalize also stamps the URL and file metadata onto the row, because the form keeps only the
  // URL — that stamp is how `save` finds the identity again and builds a full attachment row from it.
  //
  // Used ONLY where the save path actually performs that commit. A purpose that adopts this mode
  // without one gets its live files destroyed 24 hours later, which is why `return-url` remains the
  // default for the surfaces that have not been converted.
  | "deferred-attach";

export interface UploadPurpose {
  /** Permission the caller must hold to obtain a signature. Mirrors the route that used to upload. */
  permissions: string[];
  /** True when ANY of `permissions` suffices; false when all are required. Matches requireAnyPermission. */
  anyPermission: boolean;
  folder: string;
  /** Media types the browser may send. `raw` types get a magic-byte check at finalize. */
  mediaTypes: string[];
  /** Largest file, in bytes, this purpose accepts. Enforced by the preset AND re-checked at finalize. */
  maxBytes: number;
  mode: FinalizeMode;
}

const MB = 1024 * 1024;

// The four document types every attachment surface accepts, and the four image types.
const DOCUMENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
];

/**
 * Spreadsheets, for the surfaces that carry a supplier's or a customer's own commercial paperwork.
 *
 * A price breakdown, a bill of materials and an equipment schedule all routinely arrive as a
 * workbook rather than a PDF, and until now the only way to attach one was to print it to PDF first
 * — which loses the figures the buyer actually wanted to check.
 *
 * ATTACHMENTS, not imports. Nothing in this app parses these; they are stored opaquely and handed
 * back as a download, exactly like a PDF. That is deliberate and is the reason a spreadsheet is safe
 * to accept at all: a CSV cell beginning `=` or `@` is a formula only to whatever opens it, and
 * nothing here ever opens it. The one place this app DOES parse a spreadsheet is the customer site
 * import, which is a separate flow with its own picker and never touches this catalog.
 *
 * `application/vnd.ms-excel` is the legacy .xls type. Kept because the client asked for it by
 * extension and finance systems still emit it; its OLE2 container is checked below.
 */
const SPREADSHEET_TYPES = [
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

/**
 * What a business-document surface takes: the four originals plus spreadsheets.
 *
 * Deliberately NOT what `grn_attachment` takes. A goods receipt's documents are the paperwork that
 * came off the van — a delivery note, a packing slip, a photograph of a damaged pallet — and a
 * workbook is not one of those. Widening it would be applying the client's request to a surface
 * they did not ask about, on the assumption that more types is always better.
 */
const BUSINESS_DOCUMENT_TYPES = [...DOCUMENT_TYPES, ...SPREADSHEET_TYPES];

const EVIDENCE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export const UPLOAD_PURPOSES = {
  // ── Documents. These carry the customer's own paperwork, so they get the strictest content check.
  job_attachment: {
    permissions: ["jobs.create", "jobs.edit"],
    anyPermission: true,
    folder: "senthra/jobs",
    mediaTypes: BUSINESS_DOCUMENT_TYPES,
    maxBytes: 10 * MB,
    // The job form composes attachments before the job exists, so there is nothing to attach to at
    // finalize — but `createJob`/`updateJob` reconcile the URLs it sends back into JobAttachment
    // rows, committing each ledger row as they go. That commit is what makes this mode safe here.
    mode: "deferred-attach",
  },
  prf_attachment: {
    permissions: ["purchase_requests.edit"],
    anyPermission: false,
    folder: "senthra/purchase-orders",
    mediaTypes: BUSINESS_DOCUMENT_TYPES,
    maxBytes: 10 * MB,
    mode: "attach",
  },
  po_attachment: {
    permissions: ["purchase_orders.edit"],
    anyPermission: false,
    folder: "senthra/purchase-orders",
    mediaTypes: BUSINESS_DOCUMENT_TYPES,
    maxBytes: 10 * MB,
    mode: "attach",
  },
  grn_attachment: {
    permissions: ["goods_in.edit"],
    anyPermission: false,
    folder: "senthra/goods-in",
    mediaTypes: DOCUMENT_TYPES,
    maxBytes: 5 * MB,
    mode: "attach",
  },

  // ── Evidence photos. Images only, so Cloudinary's own decode is the content check: it stores them
  // as `image` and rejects anything it cannot decode. Nothing here needs a magic-byte pass.
  //
  // ALL of them are 10 MB, and the number comes from the device rather than the use. Every one of
  // these is captured on a phone — an engineer in a van, a manager on the warehouse floor — and a
  // modern phone JPEG is routinely 4–15 MB. `damage_photo` learnt this the hard way (see the Aug
  // 2026 fix: "a photo taken on a phone was rejected while the schema promised to allow it"); the
  // other four were left at 2 MB, which is the same defect waiting in four more places.
  //
  // The browser now downscales before it uploads (frontend lib/image.ts), so a typical capture
  // arrives a few hundred KB and never approaches this. The ceiling is the BACKSTOP for the cases
  // compression cannot handle — a format canvas will not decode, a device too constrained to
  // re-encode — where the original is sent as-is. Lowering it again re-blocks exactly those users.
  damage_photo: {
    permissions: ["goods_management.receive_return", "inventory.adjust"],
    anyPermission: true,
    folder: "senthra/damage-photos",
    mediaTypes: EVIDENCE_IMAGE_TYPES,
    maxBytes: 10 * MB,
    mode: "return-url",
  },
  vsr_attachment: {
    permissions: ["engineer.van_stock.request"],
    anyPermission: false,
    folder: "senthra/van-stock-requests",
    mediaTypes: EVIDENCE_IMAGE_TYPES,
    maxBytes: 10 * MB,
    mode: "return-url",
  },
  vsr_damage_photo: {
    permissions: ["van_stock_request.review"],
    anyPermission: false,
    folder: "senthra/damage-photos",
    mediaTypes: EVIDENCE_IMAGE_TYPES,
    maxBytes: 10 * MB,
    mode: "return-url",
  },
  // Condition evidence on a HIRE delivery — how the supplier's kit looked as it came off the van.
  // `attach` rather than `return-url`, unlike the other evidence photos here: this one lands on a
  // record that already exists by the time it is taken (the delivery), so it can carry the Cloudinary
  // identity that lets the asset be destroyed with it. The return-url photos cannot — they are picked
  // before their record exists, which is why theirs are stored as bare URLs.
  hire_delivery_photo: {
    // ANY of the three, and `anyPermission` is what makes that true — `assertPermitted` reads `false`
    // as `.every()`. No role holds them all (the warehouse gets `receive` + `settle`, the PM
    // `manage`), so requiring every one left every seeded role unable to attach a photo and only a
    // `*` super-admin able to — which is what dev testing runs as.
    //
    // The SAME list as HIRE_FLOOR in rental-receipt.routes.ts: this photo rides on the notes those
    // routes write, so a role that can post the movement must be able to attach its evidence.
    permissions: ["rentals.hire.receive", "rentals.hire.settle", "rentals.hire.manage"],
    anyPermission: true,
    folder: "senthra/hire-deliveries",
    mediaTypes: EVIDENCE_IMAGE_TYPES,
    maxBytes: 10 * MB,
    mode: "attach",
  },
  transfer_attachment: {
    permissions: ["engineer.transfer", "engineer_stock.transfer"],
    anyPermission: true,
    folder: "senthra/engineer-transfers",
    mediaTypes: EVIDENCE_IMAGE_TYPES,
    maxBytes: 10 * MB,
    mode: "return-url",
  },
} as const satisfies Record<string, UploadPurpose>;

export type UploadPurposeKey = keyof typeof UPLOAD_PURPOSES;

export function isUploadPurpose(v: string): v is UploadPurposeKey {
  return Object.prototype.hasOwnProperty.call(UPLOAD_PURPOSES, v);
}

/**
 * Which Cloudinary resource type a media type is stored as.
 *
 * The SAME rule the old server-side path used, and it has to stay the same or existing assets and new
 * ones would live on different delivery paths. Images go up as `image` so Cloudinary decodes them and
 * their transformations work; everything else goes up as `raw`, because Cloudinary classifies a PDF
 * as an image and lands it on a delivery path most accounts block for PDFs.
 */
export function resourceTypeFor(mediaType: string): "image" | "raw" {
  return mediaType.toLowerCase().startsWith("image/") ? "image" : "raw";
}

/**
 * Leading bytes that identify each document type we accept, for the finalize check.
 *
 * Only `raw` uploads need this. Cloudinary stores a raw asset opaquely — its `allowed_formats`
 * restriction and the `format` it reports are both read from the extension in the public_id, which
 * for a PDF or DOCX is a label the caller chose. These bytes are the file itself.
 */
export type ContentSignature =
  /** Positive test: these exact leading bytes must be present. */
  | { mediaType: string; bytes: number[]; searchWindow?: number; text?: undefined }
  /**
   * Negative test, for a format that HAS no signature: the probe must not look binary.
   *
   * CSV is plain text and there is no byte sequence that identifies one — a file of digits and commas
   * is as valid as a file of quoted prose, and a leading BOM is optional. So the check is inverted:
   * rather than prove it is a CSV, refuse anything that is demonstrably NOT text. That is the whole
   * of what the positive checks buy us here anyway — nothing about `%PDF-` proves the rest of the
   * file is a readable invoice either; it proves the upload is not a renamed executable.
   *
   * See `BINARY_HEADERS` for what it rejects.
   */
  | { mediaType: string; text: true; bytes?: undefined; searchWindow?: undefined };

export const CONTENT_SIGNATURES: ContentSignature[] = [
  // "%PDF-". Searched rather than anchored: writers do prepend bytes and every real reader scans for
  // it, so demanding offset 0 would refuse invoices that open fine everywhere else.
  { mediaType: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], searchWindow: 1024 },
  // DOCX is a ZIP container. Strict at offset 0 — a ZIP with junk in front is genuinely broken.
  {
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: [0x50, 0x4b, 0x03, 0x04],
  },
  // XLSX is the SAME ZIP container as DOCX — an OOXML part. These bytes therefore cannot tell a
  // workbook from a document, and that is fine rather than a gap: both are accepted on every surface
  // that accepts either, so a mislabelled one lands somewhere it was already allowed to land. What
  // the check is for is the file that is neither, and it still refuses those.
  {
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: [0x50, 0x4b, 0x03, 0x04],
  },
  // Legacy .xls is an OLE2 compound file. Same caveat as XLSX: the container is shared with .doc and
  // .ppt, so this proves "a real Office binary", not "a workbook".
  { mediaType: "application/vnd.ms-excel", bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  // No signature exists. Checked by exclusion — see ContentSignature.
  { mediaType: "text/csv", text: true },
];

/**
 * Bytes that can appear in a plain-text file.
 *
 * Printable ASCII, the three whitespace controls a CSV actually contains, and everything from 0x80
 * up — which is every byte of a UTF-8 multi-byte sequence and every accented character of a Latin-1
 * export, so a supplier list full of "Müller" is text. What is left is the C0 control range and DEL:
 * bytes no encoding this app can receive puts in a data file, and the ones every binary format is
 * dense with.
 */
export function isTextByte(b: number): boolean {
  if (b === 0x09 || b === 0x0a || b === 0x0d) return true; // tab, LF, CR
  if (b === 0x7f) return false; // DEL
  return b >= 0x20;
}

/** Printable ASCII — the range a header has to fall inside to be confusable with real CSV text. */
export function isPrintableAscii(b: number): boolean {
  return b >= 0x20 && b <= 0x7e;
}

/**
 * The shortest all-printable header long enough to stand on its own as evidence of a binary.
 *
 * Four, because the failure this exists to prevent was a two-byte one. `MZ` is two printable letters
 * and a genuine parts CSV opens `MZ1200,Bracket,4` — a real customer SKU prefix — which the check
 * refused as a Windows executable AFTER the whole upload had completed. Two printable bytes is a
 * coincidence a real CSV produces; `%PDF`, `GIF8` and `Rar!` are not.
 */
export const MIN_PRINTABLE_HEADER_BYTES = 4;

/**
 * Headers that mean "this is a binary file", used to refuse one declared as CSV.
 *
 * The list is the formats a renamed upload would plausibly BE — an executable, an archive, or one of
 * the container formats already handled above. It is not meant to be exhaustive, and it does not need
 * to be: the text sweep in `assertLooksLikeText` rejects the overwhelming majority of binaries on its
 * own (every one of these formats is dense with control bytes within the first few hundred), and this
 * list is the belt to that braces for the handful whose first 1024 bytes happen not to be.
 *
 * What it deliberately does NOT do is try to validate CSV structure — no comma count, no column
 * check. A one-column export with no delimiter at all is a legitimate CSV, and a rule that refused it
 * would break real uploads to catch nothing a text check does not already catch.
 *
 * This is the full CATALOGUE. Which of these entries may reject a file BY THEMSELVES is a separate
 * question, answered by `CSV_HEADER_GUARDS` — see there.
 */
export const BINARY_HEADERS: { label: string; bytes: number[] }[] = [
  { label: "Windows executable", bytes: [0x4d, 0x5a] }, // MZ — .exe/.dll
  { label: "Linux executable", bytes: [0x7f, 0x45, 0x4c, 0x46] }, // ELF
  { label: "macOS executable", bytes: [0xcf, 0xfa, 0xed, 0xfe] }, // Mach-O 64-bit
  { label: "Java class", bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { label: "ZIP archive", bytes: [0x50, 0x4b, 0x03, 0x04] }, // also DOCX/XLSX — not a CSV either way
  { label: "RAR archive", bytes: [0x52, 0x61, 0x72, 0x21] },
  { label: "7-Zip archive", bytes: [0x37, 0x7a, 0xbc, 0xaf] },
  { label: "gzip archive", bytes: [0x1f, 0x8b] },
  { label: "OLE2 document", bytes: [0xd0, 0xcf, 0x11, 0xe0] }, // .xls/.doc
  { label: "PDF", bytes: [0x25, 0x50, 0x44, 0x46] },
  { label: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { label: "GIF", bytes: [0x47, 0x49, 0x46, 0x38] },
  { label: "JPEG", bytes: [0xff, 0xd8, 0xff] },
];

/**
 * The headers that may reject a CSV on the strength of the header ALONE.
 *
 * Two layers guard a CSV, and only the first is a rule about the whole file: the probe must be text
 * (`assertLooksLikeText`). That layer is what actually catches a renamed binary — every format in the
 * catalogue above is dense with control bytes, and a real PE cannot avoid them: its DOS header, the
 * `PE\0\0` marker and the stub between them are full of NULs before byte 128.
 *
 * This second layer is the net for a binary whose first 1024 bytes happen to read as text. It matches
 * on a prefix, and a prefix is only evidence if a real CSV could not begin with it — so an
 * all-printable header has to be at least `MIN_PRINTABLE_HEADER_BYTES` long to qualify. That excludes
 * exactly one entry, `MZ`, which is why `MZ1200,Bracket,4` is now accepted; every other header either
 * contains a byte no text file has (ELF's DEL, ZIP's 0x03, OLE2's 0x11, gzip's 0x1f, PNG's 0x89,
 * JPEG's 0xff) or is four printable bytes that no parts list opens with (`%PDF`, `GIF8`, `Rar!`).
 *
 * Nothing is weakened by the exclusion: a genuine executable is refused by the text sweep a layer
 * earlier, and what `MZ` now lets through is a file of printable text that starts with two letters —
 * which is a CSV, whatever else it also happens to be the prefix of.
 */
export const CSV_HEADER_GUARDS: { label: string; bytes: number[] }[] = BINARY_HEADERS.filter(
  (h) => !h.bytes.every(isPrintableAscii) || h.bytes.length >= MIN_PRINTABLE_HEADER_BYTES,
);

/** How many bytes finalize needs to read to decide. The widest search window above. */
export const CONTENT_PROBE_BYTES = 1024;
