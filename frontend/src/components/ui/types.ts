// Shared UI types used across forms and primitives (app-wide, not feature-specific).

// A success / error feedback message rendered by <Notice>. `null` = nothing to show.
export type Msg = { type: "success" | "error"; text: string } | null;
