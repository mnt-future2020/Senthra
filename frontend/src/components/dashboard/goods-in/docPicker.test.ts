import { describe, expect, it } from "vitest";

import { isImageType, resolveDocType, stageFiles } from "./docPicker";

const allowedFrom = (accept: string) =>
  new Set(accept.split(",").map((e) => e.trim().replace(/^\./, "").toLowerCase()));

const GRN_ACCEPT = ".pdf,.docx,.png,.jpg,.jpeg";
const PHOTO_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp";

/**
 * The picker advertises its accepted types through `accept` — which is what the OS file dialog
 * offers — and then gates on a SEPARATE extension map. When the two disagree, the dialog offers a
 * file the picker refuses, with a toast that lists the very type it just rejected.
 *
 * That is what happened to hire condition photos: `accept` allows .gif and .webp (the server does
 * too — EVIDENCE_IMAGE_TYPES), while the map knew only pdf/docx/png/jpg/jpeg. A .webp off an
 * Android share is routine on site, and condition evidence cannot be recaptured once the van has
 * gone.
 */
describe("resolveDocType", () => {
  it("accepts every type the hire photo picker advertises", () => {
    const allowed = allowedFrom(PHOTO_ACCEPT);
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp"]) {
      expect(resolveDocType(`evidence.${ext}`, allowed), ext).not.toBeNull();
    }
  });

  it("accepts every type the goods-receipt picker advertises", () => {
    const allowed = allowedFrom(GRN_ACCEPT);
    for (const ext of ["pdf", "docx", "png", "jpg", "jpeg"]) {
      expect(resolveDocType(`note.${ext}`, allowed), ext).not.toBeNull();
    }
  });

  // The gate is still a gate: a surface that does not advertise a type must not take it.
  it("refuses a type this surface does not advertise", () => {
    expect(resolveDocType("scan.pdf", allowedFrom(PHOTO_ACCEPT))).toBeNull();
    expect(resolveDocType("anim.gif", allowedFrom(GRN_ACCEPT))).toBeNull();
  });

  it("refuses a type nothing advertises, however it is spelled", () => {
    expect(resolveDocType("payload.exe", allowedFrom(PHOTO_ACCEPT))).toBeNull();
    expect(resolveDocType("noextension", allowedFrom(PHOTO_ACCEPT))).toBeNull();
  });

  it("normalises jpeg to jpg but keeps gif and webp as themselves", () => {
    const allowed = allowedFrom(PHOTO_ACCEPT);
    expect(resolveDocType("a.JPEG", allowed)).toBe("jpg");
    expect(resolveDocType("a.gif", allowed)).toBe("gif");
    expect(resolveDocType("a.webp", allowed)).toBe("webp");
  });
});

describe("isImageType", () => {
  // These render in the lightbox, not behind a file icon — they are pictures.
  it("counts gif and webp as images", () => {
    for (const t of ["png", "jpg", "gif", "webp"]) expect(isImageType(t), t).toBe(true);
    for (const t of ["pdf", "docx"]) expect(isImageType(t), t).toBe(false);
  });
});

/**
 * The running total must follow what was actually STAGED.
 *
 * The loop advanced it by the ORIGINAL file's size, not the shrunk one the picker measured and
 * staged — and advanced it for REJECTED files too. Seven 6 MB phone photos that each downscale to
 * ~400 KB accumulated 42 MB against a 40 MB cap, so the last was refused with "Total files can't
 * exceed 40 MB" while the staged set was under 3 MB.
 */
describe("stageFiles", () => {
  it("counts the staged size, not the size that was picked", async () => {
    const seen: number[] = [];
    // Each 6 MB pick stages at 400 KB, as a phone photo does.
    await stageFiles([1, 2, 3], { bytes: 0, count: 0 }, async (_f, bytes) => {
      seen.push(bytes);
      return 400_000;
    });
    expect(seen).toEqual([0, 400_000, 800_000]);
  });

  it("does not advance the total or the count for a rejected file", async () => {
    const seen: { bytes: number; count: number }[] = [];
    await stageFiles([1, 2, 3], { bytes: 0, count: 0 }, async (f, bytes, count) => {
      seen.push({ bytes, count });
      return f === 2 ? null : 1000; // the middle file is refused
    });
    expect(seen).toEqual([
      { bytes: 0, count: 0 },
      { bytes: 1000, count: 1 },
      { bytes: 1000, count: 1 },
    ]);
  });

  it("starts from what is already on screen", async () => {
    const seen: { bytes: number; count: number }[] = [];
    await stageFiles([1], { bytes: 5000, count: 2 }, async (_f, bytes, count) => {
      seen.push({ bytes, count });
      return 100;
    });
    expect(seen).toEqual([{ bytes: 5000, count: 2 }]);
  });
});
