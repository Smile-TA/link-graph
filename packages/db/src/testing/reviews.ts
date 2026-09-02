/**
 * A `finding_reviews` row to vary one field of (PRD §7.1, `011`).
 *
 * Shared for the reason `packages/cli/src/testing/report.ts` gives for `someMetrics`:
 * the row carries nine columns, and three builders in three packages — the bucketing
 * unit tests, the report's, and this package's own integration tests — is three things
 * to edit every time a column is added.
 *
 * The defaults are one of the 16 correct-and-intentional findings step 7's gate found on
 * integrity.com (PRD §2), because a builder whose defaults are a real finding makes a
 * test that overrides nothing still assert against something that exists. `siteId` is a
 * placeholder: an integration test overrides it with a real `sites.id`, and a unit test
 * never reads it.
 */
import type { FindingReviewInput, FindingReviewRow } from "../repo/finding-reviews.js";

export const someFindingReviewInput = (
  over: Partial<FindingReviewInput> = {},
): FindingReviewInput => ({
  siteId: 1,
  kind: "orphan",
  subject: "https://integrity.com/agents/thank-you/",
  state: "intentional",
  note: "reached after form submit",
  // 64 hex characters, the shape `evidenceDigest` produces. Overridden by every test
  // that is about rule 5, since only the real digest of real evidence reads `reviewed`.
  evidenceDigest: "a".repeat(64),
  reviewedBy: "smile",
  reviewedAt: new Date("2026-09-02T10:00:00Z"),
  ...over,
});

/** The same row as it comes back out of the table, for the read-path tests. */
export const someFindingReview = (
  over: Partial<FindingReviewRow> = {},
): FindingReviewRow => ({ id: 1, ...someFindingReviewInput(over), ...over });
