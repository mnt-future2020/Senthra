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
const EVIDENCE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export const UPLOAD_PURPOSES = {
  // ── Documents. These carry the customer's own paperwork, so they get the strictest content check.
  job_attachment: {
    permissions: ["jobs.create", "jobs.edit"],
    anyPermission: true,
    folder: "senthra/jobs",
    mediaTypes: DOCUMENT_TYPES,
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
    mediaTypes: DOCUMENT_TYPES,
    maxBytes: 10 * MB,
    mode: "attach",
  },
  po_attachment: {
    permissions: ["purchase_orders.edit"],
    anyPermission: false,
    folder: "senthra/purchase-orders",
    mediaTypes: DOCUMENT_TYPES,
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
export const CONTENT_SIGNATURES: { mediaType: string; bytes: number[]; searchWindow?: number }[] = [
  // "%PDF-". Searched rather than anchored: writers do prepend bytes and every real reader scans for
  // it, so demanding offset 0 would refuse invoices that open fine everywhere else.
  { mediaType: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], searchWindow: 1024 },
  // DOCX is a ZIP container. Strict at offset 0 — a ZIP with junk in front is genuinely broken.
  {
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: [0x50, 0x4b, 0x03, 0x04],
  },
];

/** How many bytes finalize needs to read to decide. The widest search window above. */
export const CONTENT_PROBE_BYTES = 1024;
