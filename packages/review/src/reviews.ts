/**
 * The package's one piece of I/O: this site's reviews of one kind, keyed by subject.
 *
 * It is the seam the implementation plan names for step 7.6 — `reviewsFor(pool, siteId,
 * kind) → Map<subject, Review>` — and it is a read. Nothing in this package writes:
 * recording a judgement is `upsertFindingReview` in `@link-graph/db`, because SQL lives
 * in the db package (engineering guide §6) and a second function that only forwards to it
 * would be indirection with nothing in it.
 */
import {
  listFindingReviews,
  type FindingKind,
  type FindingReviewRow,
} from "@link-graph/db";
import type { Queryable } from "@link-graph/db";

/**
 * `siteId` is the surrogate `sites.id`, as `crawls.siteId` is — not the slug a person
 * types. The slug is resolved once, by the command, because the row it resolves to is
 * needed for node identity anyway.
 *
 * A `Map` rather than a list: the caller has one lookup per finding, and a linear scan
 * per finding over 538 orphans and their reviews is the shape that turns a report into
 * a wait.
 */
export async function reviewsFor(
  db: Queryable,
  siteId: number,
  kind: FindingKind,
): Promise<Map<string, FindingReviewRow>> {
  // No guard against two reviews of one subject: `UNIQUE (site_id, kind, subject)` in
  // `011` is that guard, in the same table this reads, so a check here could only ever
  // restate it.
  const rows = await listFindingReviews(db, siteId, kind);
  return new Map(rows.map((row) => [row.subject, row]));
}
