/**
 * The three-way split every finding table is shown in (PRD §9): **new**, **changed
 * since review**, **reviewed**.
 *
 * Pure, and it takes the measured findings as given. That is PRD §7.1 rule 1 expressed
 * as a function signature: nothing here can add, drop or renumber a finding, so a
 * reviewed table and `crawl_metrics` cannot disagree. Every finding handed in comes back
 * out, in the order it arrived — the order the caller sorted it into — carrying which of
 * the three it belongs to.
 */
import { REVIEW_STATES, type FindingReviewRow, type ReviewState } from "@link-graph/db";
import { evidenceDigest, type FindingEvidence } from "./evidence.js";

/**
 * `new` and `changed` rank together (PRD §7.1 rule 5) and are kept apart because they
 * are different news: nobody has looked at a `new` finding, and a `changed` one has
 * been judged against evidence that has since moved.
 */
export const REVIEW_BUCKETS = ["new", "changed", "reviewed"] as const;
export type ReviewBucket = (typeof REVIEW_BUCKETS)[number];

/**
 * One measured finding: its subject (PRD §7.1 rule 2) and its current evidence.
 *
 * Parameterised by the evidence, so a table of orphans is a different type from a table
 * of broken links and the report cannot print one under the other's columns. The
 * alternative was narrowing the union per row and refusing a mismatch at run time — a
 * check for something the caller can be prevented from doing.
 */
export interface Finding<E extends FindingEvidence = FindingEvidence> {
  readonly subject: string;
  readonly evidence: E;
}

export interface ReviewedFinding<E extends FindingEvidence = FindingEvidence> {
  readonly finding: Finding<E>;
  /** The review, `null` only in the `new` bucket. Carried so the report can date it. */
  readonly review: FindingReviewRow | null;
  readonly bucket: ReviewBucket;
}

/**
 * Join the findings this crawl measured with the reviews this site has, by subject.
 *
 * A review with no matching finding is silently absent from the result, and that is the
 * intended reading rather than a dropped row: the finding is gone — the orphan gained a
 * link, or the page was deleted — and PRD §7.1 rule 4 is that a live measurement outranks
 * a stored human claim. The review stays in the table because the finding may come back.
 *
 * **`reappeared` closes the gap §7.1 left open until step 13's crawl history:** a
 * finding that disappeared and later returned must not silently reactivate its old
 * review — the page (or link) that exists today may not be the one that was judged, and
 * a reader who never sees it re-ranked as `new` never finds out it went away at all.
 * Callers compute the set from `@link-graph/diffs`' `reappearedSince` against
 * `crawl_diffs`; the default is empty so a caller that has not wired the history through
 * yet gets today's behaviour rather than a silent type error.
 */
export function bucketFindings<E extends FindingEvidence>(
  findings: readonly Finding<E>[],
  reviews: ReadonlyMap<string, FindingReviewRow>,
  reappeared: ReadonlySet<string> = new Set(),
): ReviewedFinding<E>[] {
  return findings.map((finding) => {
    const review = reviews.get(finding.subject) ?? null;
    if (review === null || reappeared.has(finding.subject)) {
      return { finding, review: null, bucket: "new" };
    }
    const current = evidenceDigest(finding.evidence);
    return {
      finding,
      review,
      bucket: review.evidenceDigest === current ? "reviewed" : "changed",
    };
  });
}

/**
 * The three counts. All three keys always, because PRD §9 requires all three printed:
 * a tally built from the buckets that occur would leave "0 new" off exactly the report
 * where it is the headline.
 */
export function countBuckets(
  bucketed: readonly ReviewedFinding[],
): Record<ReviewBucket, number> {
  const counts = { new: 0, changed: 0, reviewed: 0 };
  for (const row of bucketed) counts[row.bucket] += 1;
  return counts;
}

/**
 * The reviewed findings by what their review claims (PRD §7.1 rule 3) — how much of the
 * backlog is deliberate (`intentional`) versus outstanding (`acknowledged`).
 *
 * Only the `reviewed` bucket is counted. A `changed` finding's review was written against
 * evidence that has moved, so counting it as backlog would report a judgement that has
 * been overtaken.
 */
export function countStates(
  bucketed: readonly ReviewedFinding[],
): Record<ReviewState, number> {
  // The cast is safe because the keys are `REVIEW_STATES` itself, which is exactly the
  // union: `Object.fromEntries` is typed as `Record<string, number>` and cannot know
  // that. Built from the vocabulary rather than written out so that a third state is
  // counted rather than silently left out of the split.
  const counts = Object.fromEntries(REVIEW_STATES.map((state) => [state, 0])) as Record<
    ReviewState,
    number
  >;
  for (const row of bucketed) {
    if (row.bucket === "reviewed" && row.review !== null) counts[row.review.state] += 1;
  }
  return counts;
}
