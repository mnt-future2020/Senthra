// Shared UI types used across forms and primitives (app-wide, not feature-specific).

import type { NoticeType } from "./noticeTone";

// A feedback message rendered by <Notice>. `null` = nothing to show.
//
// "warn" is for advisories that do NOT block the user — a duplicate open request, a stock count that
// couldn't be loaded. They used to be sent as "error" because there was no other option, which gave
// the mildest messages on a page the loudest styling. Rule of thumb: if the user can still press the
// button, it's a warn. See noticeTone.ts.
export type Msg = { type: NoticeType; text: string } | null;
