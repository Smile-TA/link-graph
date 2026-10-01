/**
 * `finding_reviews` — a human's judgement of a finding (PRD §7.1, `011`).
 *
 * The row is keyed on `(site_id, kind, subject)` and on nothing crawl-scoped, which is
 * the rule the whole table exists for: a note keyed on a `pages` or `links` row would
 * evaporate when retention rolls that crawl up (PRD §7).
 */
import type { Queryable } from "../pool.js";

/**
 * What a review can be about. Phase 1 has two (PRD §7.1), and both are things the
 * report already lists.
 *
 * Declared as a value with the union derived from it, the way `PAGE_CLASSES` and
 * `TRUTH_SOURCES` are: the CLI validates the word a person typed against this list
 * rather than repeating it, and `packages/review`'s digest table is
 * `satisfies Record<FindingKind, …>`, so adding a kind here is a compile error until
 * its evidence tuple is defined. The second copy is the CHECK in `011`.
 */
export const FINDING_KINDS = [
  /** A page in the truth source, published, indexable, with no inbound internal link. */
  "orphan",
  /**
   * An internal link whose target served >= 400. The subject is the **target**, not the
   * pages linking to it: those are its blast radius, and they change crawl to crawl.
   */
  "broken_internal_link",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/**
 * The two review states (PRD §7.1 rule 3). Both mean "do not rank this as new"; they
 * differ in what they claim, and the difference is the only number a reader gets out of
 * reviewing — how much of the backlog is deliberate versus outstanding.
 *
 * **There is deliberately no `fixed`** (rule 4): a fixed orphan gains an inbound link
 * and the next crawl stops reporting it, so a hand-written "fixed" would let a stale
 * human claim outrank a live measurement. The CHECK in `011` refuses one.
 */
export const REVIEW_STATES = [
  /** Unlinked by design, not a defect — a form thank-you page. */
  "intentional",
  /** A real defect, seen, not fixed yet — `/integrityconnect-ip-old/`. */
  "acknowledged",
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export interface FindingReviewInput {
  /** The surrogate `sites.id`, as `crawls.siteId` is — not the slug. */
  readonly siteId: number;
  readonly kind: FindingKind;
  /** The `url_normalized` the finding is about (PRD §7.1 rule 2). */
  readonly subject: string;
  readonly state: ReviewState;
  /** Required and non-blank: PRD §2's reviewed finding is one judged *with a note*. */
  readonly note: string;
  /** What was true when the review was written (rule 5). Computed in packages/review. */
  readonly evidenceDigest: string;
  readonly reviewedBy: string;
  readonly reviewedAt: Date;
}

export interface FindingReviewRow extends FindingReviewInput {
  readonly id: number;
}

const COLUMNS = `id, site_id AS "siteId", kind, subject, state, note,
  evidence_digest AS "evidenceDigest", reviewed_by AS "reviewedBy",
  reviewed_at AS "reviewedAt"`;

/**
 * Write a review, replacing any earlier one for the same `(site, kind, subject)`.
 *
 * Upsert rather than insert, because re-judging a finding is the ordinary case: a
 * finding that came back as `changed since review` is judged again, and that has to
 * refresh the digest or it would report as changed forever. The caller reads the
 * previous row first when it needs to say whose judgement it replaced —
 * `findFindingReview` — since overwriting someone else's note silently is a loss that
 * looks like a success.
 */
export async function upsertFindingReview(
  db: Queryable,
  review: FindingReviewInput,
): Promise<FindingReviewRow> {
  const { rows } = await db.query<FindingReviewRow>(
    `INSERT INTO finding_reviews
       (site_id, kind, subject, state, note, evidence_digest, reviewed_by, reviewed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (site_id, kind, subject) DO UPDATE SET
       state = excluded.state,
       note = excluded.note,
       evidence_digest = excluded.evidence_digest,
       reviewed_by = excluded.reviewed_by,
       reviewed_at = excluded.reviewed_at
     RETURNING ${COLUMNS}`,
    [
      review.siteId,
      review.kind,
      review.subject,
      review.state,
      review.note,
      review.evidenceDigest,
      review.reviewedBy,
      review.reviewedAt,
    ],
  );
  const row = rows[0];
  if (row === undefined) {
    // Unreachable while the statement above has no WHERE on the UPDATE branch, and
    // here because the alternative to a loud failure is a CLI that prints "noted" for
    // a judgement that was never stored (engineering guide §1).
    throw new Error(
      `upsertFindingReview wrote no row for ${review.kind} ${review.subject} on site ` +
        `${review.siteId}`,
    );
  }
  return row;
}

/** Every review of one kind for one site — the read path the report joins on. */
export async function listFindingReviews(
  db: Queryable,
  siteId: number,
  kind: FindingKind,
): Promise<FindingReviewRow[]> {
  const { rows } = await db.query<FindingReviewRow>(
    `SELECT ${COLUMNS} FROM finding_reviews
     WHERE site_id = $1 AND kind = $2 ORDER BY subject`,
    [siteId, kind],
  );
  return rows;
}

export async function findFindingReview(
  db: Queryable,
  siteId: number,
  kind: FindingKind,
  subject: string,
): Promise<FindingReviewRow | null> {
  const { rows } = await db.query<FindingReviewRow>(
    `SELECT ${COLUMNS} FROM finding_reviews
     WHERE site_id = $1 AND kind = $2 AND subject = $3`,
    [siteId, kind, subject],
  );
  return rows[0] ?? null;
}

/**
 * Clears a review entirely — not the same as re-judging it (`upsertFindingReview`
 * already handles that). For when the judgement itself was wrong, not just its note:
 * the finding goes back to ranking as `new` on the next report rather than carrying a
 * replacement claim. Returns the row that was deleted, `null` if there was none, so the
 * caller can tell a genuine removal from a no-op.
 */
export async function deleteFindingReview(
  db: Queryable,
  siteId: number,
  kind: FindingKind,
  subject: string,
): Promise<FindingReviewRow | null> {
  const { rows } = await db.query<FindingReviewRow>(
    `DELETE FROM finding_reviews WHERE site_id = $1 AND kind = $2 AND subject = $3
     RETURNING ${COLUMNS}`,
    [siteId, kind, subject],
  );
  return rows[0] ?? null;
}
