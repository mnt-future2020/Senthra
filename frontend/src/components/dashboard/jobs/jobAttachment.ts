import { SPREADSHEET_EXTENSIONS } from "@/lib/uploadPolicy";

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
// There is no extension→media-type table here any more. `lib/uploadPolicy` owns it (EXT_MEDIA_TYPE),
// alongside the accept string and the help-text wording it has to agree with, and `lib/upload`
// derives every declaration from it. A second copy in this file was the last thing that could tell
// a job upload a different story from the PRF and PO ones — and once Jobs began accepting
// spreadsheets, it was already telling one: it listed five extensions and Jobs accepted eight.

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
 * Extensions that render behind a FILE icon rather than the external-link one.
 *
 * `.doc` is here and is NOT in the upload policy: nothing can upload one any more, but jobs created
 * before the current picker still hold them and they are still documents on screen.
 *
 * The spreadsheets come from the shared policy rather than a list written out here, because that is
 * the list that decides what can arrive in the first place. When Jobs gained CSV/XLS/XLSX this file
 * was not updated, and every one of them rendered with the LinkIcon — the affordance that means
 * "somebody pasted a URL" — on the office form, the office detail, the engineer's job page and the
 * CUSTOMER PORTAL. Deriving it means the next format added cannot repeat that.
 */
const DOC_EXTENSIONS = [".docx", ".doc", ...SPREADSHEET_EXTENSIONS.map((e) => `.${e}`)];

/** Extensions that render as a thumbnail rather than an icon. */
const IMG_EXTENSIONS = [".png", ".jpg", ".jpeg"];

/**
 * The path part of a value, lowercased — query and fragment removed.
 *
 * Falls back to a plain string trim for anything that is not a parseable URL, because this field
 * holds half-typed links while someone is editing and must never throw on one.
 */
function pathOf(lowerValue: string): string {
  try {
    return new URL(lowerValue).pathname;
  } catch {
    return lowerValue.split("?")[0].split("#")[0];
  }
}

/** The client-visible ceiling on job attachments. The server allows more; this is the product rule. */
export const JOB_ATTACHMENT_MAX = 20;

/**
 * Room for one more attachment?
 *
 * Shared by the buttons (which disable) and the drop handler (which refuses with a message), so the
 * two interaction paths cannot enforce different limits. They did: the buttons stopped at 20 and a
 * DROP did not check at all, so dragging past the cap appended a 21st that then persisted, the
 * server's own limit being 50.
 */
export function canAddJobAttachment(currentCount: number): boolean {
  return currentCount < JOB_ATTACHMENT_MAX;
}

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
  // The extension is read from the PATH, never from the whole URL.
  //
  // A Cloudinary delivery URL ends in an analytics parameter — `…/schedule-<uuid>.xlsx?_a=BAMAPqfm0`
  // — so `endsWith(".xlsx")` is false for every file this app has ever uploaded. `isImg` and `isPdf`
  // survived that by accident, via their `/image/upload/` and `/raw/upload/` fallbacks; `isDoc` had
  // no fallback, which is why DOCX attachments have been rendering with the external-LINK icon since
  // before spreadsheets existed. Stripping the query once, here, fixes the whole family rather than
  // adding a fourth special case.
  const path = pathOf(lower);

  const isImg = IMG_EXTENSIONS.some((ext) => path.endsWith(ext)) || path.includes("/image/upload/");
  const isPdf = path.endsWith(".pdf") || (path.includes("/raw/upload/") && path.includes(".pdf"));
  const isDoc = DOC_EXTENSIONS.some((ext) => path.endsWith(ext));

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
