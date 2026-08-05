// Which halves of the scan panel a job can actually use.
//
// A CANCELLED job is return-only. The work is off, so nothing more may be issued (the server refuses
// it: postIssue accepts accepted/in_progress), but the kit the engineer is already holding still has
// to come back — which is exactly why cancelling now opens the return path instead of sealing it.
// Offering an Issue tab there would be a button whose only outcome is a 409, so it isn't offered.
export type ScanDirection = "issue" | "return";

export function scanDirections(jobStatus: string): readonly ScanDirection[] {
  return jobStatus === "cancelled" ? (["return"] as const) : (["issue", "return"] as const);
}

// The tab to land on. Never a direction the job doesn't have — a cancelled job opening on "issue"
// would show an empty, unusable panel.
export function defaultScanDirection(jobStatus: string): ScanDirection {
  return scanDirections(jobStatus)[0];
}
