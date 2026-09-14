/**
 * Closes PRD §7.1's own open gap: "a finding that disappears and later returns silently
 * reactivates its old review." Reactivation is a fact about what a review means, so it
 * lives beside the rest of review semantics (`bucketFindings`, `evidenceDigest`) rather
 * than being assembled by each caller — a report route and a future review UI would
 * otherwise have to remember the same two-step computation independently.
 */
import { reappearedSince, type DiffEvent } from "@link-graph/diffs";
import type { FindingReviewRow } from "@link-graph/db";

/**
 * Which of this site's *reviewed* subjects disappeared and later came back.
 *
 * Only reviewed subjects are checked — an unreviewed finding has no old judgement to
 * reactivate — and `events` is grouped by subject once rather than re-filtered per
 * review, so this is O(reviews + events) rather than O(reviews × events).
 */
export function reappearedSubjects(
  reviews: ReadonlyMap<string, FindingReviewRow>,
  events: readonly DiffEvent[],
): Set<string> {
  const bySubject = new Map<string, DiffEvent[]>();
  for (const event of events) {
    const forSubject = bySubject.get(event.subject);
    if (forSubject === undefined) bySubject.set(event.subject, [event]);
    else forSubject.push(event);
  }

  const reappeared = new Set<string>();
  for (const [subject, review] of reviews) {
    const subjectEvents = bySubject.get(subject);
    if (subjectEvents !== undefined && reappearedSince(subjectEvents, review.reviewedAt)) {
      reappeared.add(subject);
    }
  }
  return reappeared;
}
