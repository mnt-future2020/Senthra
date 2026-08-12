// ── Reading a job attachment string ────────────────────────────────────────────────────────────
//
// A job's `attachments` are plain strings, and four screens render them: the office form (editable),
// the office detail, the engineer's job page and the customer portal. Each one had its own inline
// copy of this parsing — same regex, same extension checks, written out four times — so a fix to any
// of it landed on one screen and left the other three disagreeing about the same file's NAME, its
// ICON, or whether it is internal.
//
// Two things are encoded in the string itself, which is why parsing exists at all:
//
//   `#internal`  a suffix the office adds to mark an attachment staff-only. It is a URL FRAGMENT, so
//                it never reaches a server and cannot break the link — but it must be stripped before
//                the URL is shown or opened, and the portal must filter those rows out entirely.
//
//   `-<hash>`    uploads land at Cloudinary as `<sanitised-name>-<8 hex>.<ext>` (see the backend's
//                uploadAttachment), so the display name drops that suffix to show what the user
//                actually picked.

// ── Uploading ──────────────────────────────────────────────────────────────────────────────────
//
// The server decides what may be stored by reading the MEDIA TYPE out of the data URI
// (uploadAttachmentSchema). The picker, meanwhile, can only see the file EXTENSION — and the two do
// not always agree: `FileReader.readAsDataURL` takes the media type from `File.type`, which the
// browser fills in from the OS. A machine with no Office install reports `""` for a `.docx`, the
// data URI comes out as `data:application/octet-stream`, and a file the picker just accepted is
// refused by the server AFTER the whole upload — told "use PDF, DOCX, PNG or JPG" about a DOCX.
//
// So the extension we validated is also the media type we send. This is not a weakening of the
// server's gate: that gate reads a client-supplied prefix either way, so it was never a boundary
// against a hostile caller — it stops the wrong FILE, and this makes it stop the right ones.

/** Extensions the picker offers → the media type the server's allow-list names. */
export const ATTACHMENT_MEDIA_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/**
 * Restate a data URI's media type, keeping its base64 payload untouched.
 *
 * Returns the input unchanged if it isn't a base64 data URI — a caller passing something else has a
 * different problem, and rewriting an unrecognised string would corrupt it.
 */
export function withMediaType(dataUri: string, mediaType: string): string {
  const comma = dataUri.indexOf(",");
  if (comma < 0 || !dataUri.startsWith("data:")) return dataUri;
  const header = dataUri.slice(5, comma);
  if (!header.includes("base64")) return dataUri;
  return `data:${mediaType};base64,${dataUri.slice(comma + 1)}`;
}

export interface JobAttachment {
  /** the raw stored string, `#internal` included — the value to write back when editing */
  url: string;
  /** the openable URL: the same string with any `#internal` marker removed */
  rawUrl: string;
  /** what to show the user — file name with the upload hash suffix stripped */
  name: string;
  isImg: boolean;
  isPdf: boolean;
  isDoc: boolean;
  /** marked staff-only. The customer portal must not render these at all. */
  isInternal: boolean;
  /**
   * Uploaded through the app rather than pasted in.
   *
   * Decided by the Cloudinary HOST, not the file extension. Extension was wrong in the direction
   * that costs data: a pasted third-party link ending `.pdf` was classed as an upload and rendered
   * as a read-only row, so the only way to correct a mistyped URL was to delete it and start again.
   * An upload is a thing WE created and can therefore recognise by where it lives.
   */
  isUploaded: boolean;
}

const CLOUDINARY_HOST = "res.cloudinary.com";

/**
 * Strip the uniqueness suffix the upload path appends, and nothing else.
 *
 * TWO shapes, because the id changed and the older one is still in the database:
 *
 *   `-<uuid>`   current. A full UUID is unmistakable — five hex groups in a fixed 8-4-4-4-12 layout —
 *               so it needs no further guard.
 *   `-<8 hex>`  earlier uploads, which truncated the UUID. This one is ambiguous, and the pattern also
 *               matched an 8-DIGIT DATE: a user's own `site-report-20240115.pdf` displayed as
 *               `site-report.pdf`, the app silently deleting part of a real file name on the screen
 *               people use to tell two survey reports apart. Requiring at least one a–f character
 *               costs a genuinely all-numeric hash its trim and is the right side to err on — showing
 *               too much of a name is a blemish, showing the wrong name is a mistake.
 */
const UUID_SUFFIX = /^(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]+)$/i;
const SHORT_SUFFIX = /^(.+)-([a-f0-9]{8})(\.[a-z0-9]+)$/i;

function stripUploadHash(fileName: string): string {
  const uuid = UUID_SUFFIX.exec(fileName);
  if (uuid) return `${uuid[1]}${uuid[2]}`;
  const short = SHORT_SUFFIX.exec(fileName);
  if (!short || !/[a-f]/i.test(short[2])) return fileName;
  return `${short[1]}${short[3]}`;
}

/** Parse one stored attachment string. Returns null for a blank entry (the form keeps empty rows). */
export function parseJobAttachment(value: string): JobAttachment | null {
  const url = value.trim();
  if (!url) return null;

  const isInternal = /#internal$/i.test(url);
  const rawUrl = url.replace(/#internal$/i, "");
  const lower = rawUrl.toLowerCase();

  const isImg = lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.includes("/image/upload/");
  const isPdf = lower.endsWith(".pdf") || (lower.includes("/raw/upload/") && lower.includes(".pdf"));
  const isDoc = lower.endsWith(".docx") || lower.endsWith(".doc");

  // A value that isn't a parseable URL is shown verbatim rather than blanked — half-typed links live
  // in this field while someone is editing, and swallowing them would look like data loss.
  let name = rawUrl;
  let isUploaded = false;
  try {
    const parsed = new URL(rawUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    name = stripUploadHash(parts[parts.length - 1] || parsed.hostname);
    isUploaded = parsed.hostname.toLowerCase().endsWith(CLOUDINARY_HOST);
  } catch {
    name = rawUrl;
  }

  return { url, rawUrl, name, isImg, isPdf, isDoc, isInternal, isUploaded };
}
