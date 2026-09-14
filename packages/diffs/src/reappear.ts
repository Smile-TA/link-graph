/**
 * Closes the gap PRD §7.1 left open on purpose: "a finding that disappears and later
 * returns silently reactivates its old review." Now that `crawl_diffs` records every
 * appearance and resolution, a review can be checked against the history instead of
 * being trusted blind.
 */
export interface DiffEvent {
  readonly subject: string;
  readonly kind: "appeared" | "resolved";
  /** The `finished_at` of the crawl the diff was recorded against. */
  readonly at: Date;
}

/**
 * True when this subject's history has a resolve after `since`, and later appeared
 * again after that. A resolve with no later appearance is just "gone" — not this gap,
 * and not reported.
 *
 * Takes one subject's own events, already picked out by the caller — a caller checking
 * many reviews groups its full event list by subject once (`Map<string, DiffEvent[]>`)
 * rather than this function re-filtering the whole list per review, which is what made
 * checking a site's set of reviewed subjects an O(reviews × events) scan.
 */
export function reappearedSince(events: readonly DiffEvent[], since: Date): boolean {
  const after = [...events]
    .filter((event) => event.at > since)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  let resolvedAt: Date | null = null;
  for (const event of after) {
    if (event.kind === "resolved") resolvedAt ??= event.at;
    else if (resolvedAt !== null) return true;
  }
  return false;
}
