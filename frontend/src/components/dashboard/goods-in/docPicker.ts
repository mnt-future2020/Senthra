import { resolveFileType } from "@/lib/uploadPolicy";

// The file picker's two rules, extracted so they can be tested — the picker itself is JSX.
//
// Both existed inline and both were wrong in the same way: they were written for the goods receipt,
// then reused by a surface with different limits and different accepted types, and nothing tied them
// back to what that surface advertises.

/**
 * Types that render in the lightbox rather than behind a file icon.
 *
 * `image` is the odd one out: it is not a format, it is "we know this is a photograph but never
 * recorded which kind". Damage evidence is stored as a bare Cloudinary URL on the record — no file
 * row, so no name, size, or format — and that URL carries no extension to read one back from. The
 * upload purpose only ever accepted the four formats above, so the picture always renders; claiming
 * it is a JPG to get it past this gate would put a made-up format under it on screen.
 */
const IMAGE_TYPES = new Set(["png", "jpg", "gif", "webp", "image"]);

/** A `fileType` that says nothing beyond "it is an image" — omitted from the caption. */
export const UNTYPED_IMAGE = "image";

export const isImageType = (fileType: string): boolean => IMAGE_TYPES.has(fileType);

/**
 * The `fileType` to record for a picked file, or null if this surface does not take it.
 *
 * `allowed` comes from the surface's own `accept` string, so the gate can only ever be NARROWER than
 * what the dialog offered — never a different set.
 *
 * The extension→fileType map this reads now lives in `lib/uploadPolicy`, next to the accept strings
 * and the help-text wording it has to agree with, and is shared with the PRF, PO and job pickers.
 * This is kept as a named re-export because the goods-in surfaces call it by this name and its
 * behaviour has tests written against it.
 */
export function resolveDocType(fileName: string, allowed: Set<string>): string | null {
  return resolveFileType(fileName, allowed);
}

/**
 * Walk a multi-file pick, carrying the running total forward by what was actually STAGED.
 *
 * `stage` returns the accepted file's size, or null when it refused the file. Both halves matter:
 * the loop used to advance by the ORIGINAL `File.size` rather than the shrunk size the picker had
 * just measured and staged, and it advanced for refused files too. Seven 6 MB phone photos that each
 * downscale to ~400 KB therefore accumulated 42 MB against a 40 MB cap, and the last was refused
 * with "Total files can't exceed 40 MB" while the staged set was under 3 MB.
 *
 * Sequential on purpose: each file's cap check has to see what the ones before it added.
 */
export async function stageFiles<T>(
  files: T[],
  start: { bytes: number; count: number },
  stage: (file: T, bytes: number, count: number) => Promise<number | null>,
): Promise<void> {
  let { bytes, count } = start;
  for (const file of files) {
    const staged = await stage(file, bytes, count);
    if (staged == null) continue;
    bytes += staged;
    count += 1;
  }
}
