// ── What each document surface accepts ─────────────────────────────────────────────────────────
//
// The browser half of `backend/src/modules/upload/upload.catalog.ts`. Every value here MIRRORS a
// decision the server already made and re-checks; none of it is a gate. Its job is to stop the file
// dialog from offering something the server would refuse — a rejection the user reads as a bug,
// because the dialog they were just handed presented the file as valid.
//
// It exists as ONE module because it used to be five. The accept string, the extension→type map and
// the "PDF, DOCX, PNG or JPG" sentence were written out separately in the PRF form, the PRF detail,
// the PO detail, the job form and the GRN picker, so widening the policy meant finding all five and
// getting all five right — and the sentence, being prose, was the one that silently went stale.
//
// ── Two policies, not one ──
//
// The split is deliberate and matches the backend exactly:
//
//   BUSINESS_DOC  PRF, PO, Job — paperwork a supplier or customer sends about the commercial terms
//                 of the work. A price breakdown or a bill of materials arrives as a workbook often
//                 enough that refusing one forced people to print it to PDF and lose the figures.
//
//   BASE_DOC      GRN — what came off the van. A delivery note, a packing slip, a photo of a damaged
//                 pallet. A spreadsheet is not one of those, so it is not offered.
//
// Widening BASE_DOC to match BUSINESS_DOC would be the easy mistake: the two lists look like an
// oversight rather than a decision. They are a decision.

/** Extension → the `fileType` recorded on an attachment row. The superset across every surface. */
export const EXT_FILE_TYPE: Record<string, string> = {
  pdf: "pdf",
  docx: "docx",
  csv: "csv",
  xls: "xls",
  xlsx: "xlsx",
  png: "png",
  jpg: "jpg",
  // One format, one name — so a `.jpeg` and a `.jpg` are never two things on screen.
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
};

/**
 * Extension → the media type the backend catalog names.
 *
 * `File.type` comes from the OS and lies by omission: a machine with no Office install reports `""`
 * for a `.docx`, and Windows reports `application/vnd.ms-excel` for a `.csv` when Excel is the
 * registered handler — a type the server accepts for `.xls` but which would make a CSV arrive
 * declared as a binary workbook and fail its OLE2 magic-byte check. Deriving from the extension is
 * what keeps the declaration and the bytes describing the same file.
 */
export const EXT_MEDIA_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** The four types every document surface takes. GRN's whole policy; the first half of the others'. */
export const BASE_DOC_EXTENSIONS = ["pdf", "docx", "png", "jpg", "jpeg"] as const;

/** Spreadsheets. Added to PRF, PO and Job only — see the note above. */
export const SPREADSHEET_EXTENSIONS = ["csv", "xls", "xlsx"] as const;

/**
 * PRF / PO / Job. Documents first, spreadsheets, then images — the order the file dialog shows them
 * and the order the help text reads, so the two agree at a glance.
 */
export const BUSINESS_DOC_EXTENSIONS = ["pdf", "docx", "xlsx", "xls", "csv", "png", "jpg", "jpeg"] as const;

const acceptFrom = (exts: readonly string[]) => exts.map((e) => `.${e}`).join(",");

/**
 * Human wording for a set of extensions: "PDF, DOCX, XLSX, XLS, CSV, PNG or JPG".
 *
 * Derived rather than written out, which is the point — the sentence is the part that goes stale,
 * because nothing fails when it disagrees with the list beside it. `jpeg` is dropped: it is the same
 * format as `jpg` and naming both reads as two things the user must choose between.
 */
function labelFrom(exts: readonly string[]): string {
  const names = exts.filter((e) => e !== "jpeg").map((e) => e.toUpperCase());
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** `accept` for the GRN picker. */
export const BASE_DOC_ACCEPT = acceptFrom(BASE_DOC_EXTENSIONS);
/** `accept` for PRF, PO and Job. */
export const BUSINESS_DOC_ACCEPT = acceptFrom(BUSINESS_DOC_EXTENSIONS);

/** "PDF, DOCX, PNG or JPG" */
export const BASE_DOC_LABEL = labelFrom(BASE_DOC_EXTENSIONS);
/** "PDF, DOCX, XLSX, XLS, CSV, PNG or JPG" */
export const BUSINESS_DOC_LABEL = labelFrom(BUSINESS_DOC_EXTENSIONS);

/**
 * The `fileType` to record for a picked file, or null when this surface does not take it.
 *
 * `allowed` is derived from the surface's own accept string by `allowedFrom`, so the gate can only
 * ever be NARROWER than what the dialog offered — never a different set. That relationship is what
 * makes a wrong-type toast impossible to reach through the picker and meaningful when reached
 * through a DROP, which no accept string constrains.
 */
export function resolveFileType(fileName: string, allowed: Set<string>): string | null {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  // A file with no dot at all: `split` returns the whole name, which must not be read as an
  // extension that happens to be listed.
  if (!fileName.includes(".")) return null;
  if (!allowed.has(ext)) return null;
  return EXT_FILE_TYPE[ext] ?? null;
}

/** The extension set an `accept` string permits, e.g. ".pdf,.png" → {"pdf","png"}. */
export function allowedFrom(accept: string): Set<string> {
  return new Set(
    accept
      .split(",")
      .map((e) => e.trim().replace(/^\./, "").toLowerCase())
      .filter(Boolean),
  );
}
