import { z } from "zod";

// A policy is a long document, but not an unbounded one. The global JSON body limit is 5 MB and a
// legal notice has no business anywhere near it — a cap here turns "someone pasted a binary" into a
// clear validation error rather than a 5 MB row.
export const MAX_POLICY_BODY_CHARS = 100_000;

const bodyField = z
  .string({ error: "Policy content is required." })
  .max(MAX_POLICY_BODY_CHARS, `Policy content must be ${MAX_POLICY_BODY_CHARS.toLocaleString()} characters or fewer.`);

// The revision the editor was working from. Publishing and saving both carry it so a concurrent
// change is a conflict the user is told about, never a silent overwrite.
const revisionField = z
  .number({ error: "A draft revision is required." })
  .int("Draft revision must be a whole number.")
  .min(0, "Draft revision must be zero or greater.");

export const saveDraftSchema = z.object({
  body: bodyField,
  expectedRevision: revisionField,
});

export const publishSchema = z.object({
  expectedRevision: revisionField,
});

// Discard is a DRAFT WRITE, so it carries the same revision guard a save does — otherwise it would
// be the one way to overwrite somebody else's in-flight edit without being told.
export const discardDraftSchema = z.object({
  expectedRevision: revisionField,
});

// Preview renders unsaved editor content, so it takes a body and no revision — nothing is written.
export const previewSchema = z.object({
  body: bodyField,
});

export type SaveDraftInput = z.infer<typeof saveDraftSchema>;
export type PublishInput = z.infer<typeof publishSchema>;
export type DiscardDraftInput = z.infer<typeof discardDraftSchema>;
export type PreviewInput = z.infer<typeof previewSchema>;
