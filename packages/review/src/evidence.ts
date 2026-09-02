/**
 * What was true when a review was written (PRD §7.1 rule 5), as a digest.
 *
 * The rule: a review stores a digest of the finding's evidence, and when current
 * evidence differs the finding reports as `changed since review` and ranks with the new
 * ones — so an acknowledged 404 linked from 18 pages does not stay quiet once it is
 * linked from 40.
 *
 * **What the tuple must not contain is the whole design.** Every field in it is one a
 * reader would re-judge the finding over; anything that moves crawl-to-crawl without
 * meaning would re-surface every review on a site for no reason, and a reader who is
 * shown their own judgements back as new findings is back where §7.1 started. So:
 *
 * - **no `depth`** — it changes when an unrelated part of the site gains or loses a
 *   link, which on a nav-linked site is most weeks;
 * - **no crawl id and no timestamp** — either would differ on every crawl by
 *   construction, which is rule 5 inverted into "everything is always changed";
 * - **no blast-radius page list** for a broken link, only its size: PRD §7.1 rule 2 is
 *   explicit that the pages linking to a broken target are not part of its identity,
 *   and the same holds for its evidence — a nav link moving between two pages is not a
 *   change a reader would re-judge.
 *
 * Pure, and deliberately in `core` terms: no clock, no I/O, no database. The same
 * evidence digests the same in every process, which is what lets a digest written last
 * month be compared with one computed now.
 */
import { createHash } from "node:crypto";
import type { FindingKind, PageClass } from "@link-graph/db";

/**
 * The thin tuple for an orphan (PRD §7.1 rule 5): class, post type, status code.
 *
 * `class` is in the tuple because the rule names it, and on today's read path it is
 * `orphan` on every row — `listOrphanFindings` selects exactly those — so what actually
 * moves a digest is the post type or the status. Kept rather than dropped because the
 * rule is the specification and a page whose class moves stops being this finding.
 */
export interface OrphanEvidence {
  readonly kind: "orphan";
  readonly class: PageClass;
  /** `null` = no truth source named one, which is never read as content (`010`). */
  readonly postType: string | null;
  /** `null` = the page was never fetched. Never read as 200. */
  readonly statusCode: number | null;
}

/** A broken internal link's status and how many pages walk into it (PRD §2). */
export interface BrokenLinkEvidence {
  readonly kind: "broken_internal_link";
  readonly statusCode: number;
  readonly blastRadius: number;
}

export type FindingEvidence = OrphanEvidence | BrokenLinkEvidence;

/**
 * The fields the digest is taken over, per kind.
 *
 * **Two layers, and they check different things — measured, because the second one was
 * deleted as redundant and was not.** The table's `satisfies` ties the tuples to the
 * `FINDING_KINDS` vocabulary: adding a third kind there makes this object a compile error
 * until it has evidence of its own. The `switch` below is the dispatch, because
 * TypeScript cannot call a union of functions whose parameters are narrowed by
 * `Extract<…>` — and it is exhaustive over `FindingEvidence`, not over `FindingKind`, so
 * on its own it would let a new kind be added with no evidence and no error anywhere
 * (verified 2026-09-02: `FINDING_KINDS` plus one value, table removed, `tsc --noEmit`
 * clean). A kind whose evidence nobody defined is a finding whose review never
 * re-surfaces, which is rule 5 silently off.
 *
 * Values are JSON-encoded, so an absent field cannot collide with the string that spells
 * it — `post_type=null` and `post_type="null"` are different findings and must have
 * different digests.
 */
const FIELDS = {
  orphan: (evidence: OrphanEvidence) => [
    `class=${JSON.stringify(evidence.class)}`,
    `post_type=${JSON.stringify(evidence.postType)}`,
    `status=${JSON.stringify(evidence.statusCode)}`,
  ],
  broken_internal_link: (evidence: BrokenLinkEvidence) => [
    `status=${JSON.stringify(evidence.statusCode)}`,
    `blast_radius=${JSON.stringify(evidence.blastRadius)}`,
  ],
} satisfies {
  [K in FindingKind]: (evidence: Extract<FindingEvidence, { kind: K }>) => string[];
};

/**
 * The tuple, as text. Exported because it is the specification: a test pins it, and what
 * is absent from it matters more than what is in it (see the module comment).
 */
export function evidenceFields(evidence: FindingEvidence): readonly string[] {
  switch (evidence.kind) {
    case "orphan":
      return FIELDS.orphan(evidence);
    case "broken_internal_link":
      return FIELDS.broken_internal_link(evidence);
  }
}

/**
 * sha256 of the kind and its tuple. Hex, so `finding_reviews.evidence_digest` is one
 * fixed shape whatever the kind holds.
 *
 * **Changing the tuple invalidates every stored digest**, and every review on every site
 * then reads `changed since review` once. That is noisy and it is the safe direction —
 * the failure is a reader re-judging something they have already judged, not a finding
 * that stays quiet while its evidence moves. Anything that made the digest stable across
 * a tuple change would have to be a version column, and there is nothing to compare
 * versions of yet.
 */
export function evidenceDigest(evidence: FindingEvidence): string {
  return createHash("sha256")
    .update([evidence.kind, ...evidenceFields(evidence)].join("\n"))
    .digest("hex");
}
