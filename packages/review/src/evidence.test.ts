/**
 * The evidence digest (PRD §7.1 rule 5): what was true when a review was written, so
 * that a finding whose evidence has moved re-surfaces instead of staying quiet.
 *
 * Every number here is from a real crawl. `/agents/thank-you/` is one of the 8 form
 * thank-you pages on integrity.com's 2026-08-25 crawl (PRD §2), and `/integrityidol/`
 * is that crawl's worst broken internal link — 404, linked from 18 pages — which is the
 * example PRD §7.1 rule 5 is written about ("does not stay quiet once it is linked
 * from 40").
 */
import { describe, expect, it } from "vitest";
import {
  evidenceDigest,
  evidenceFields,
  type BrokenLinkEvidence,
  type OrphanEvidence,
} from "./evidence.js";

const thankYou: OrphanEvidence = {
  kind: "orphan",
  class: "orphan",
  postType: "page",
  statusCode: 200,
};

const integrityIdol: BrokenLinkEvidence = {
  kind: "broken_internal_link",
  statusCode: 404,
  blastRadius: 18,
};

describe("evidenceFields", () => {
  /**
   * The tuple is pinned rather than described, because the whole rule turns on what is
   * *not* in it. `depth` most of all: it moves whenever an unrelated part of a site
   * gains or loses a link, so a digest carrying it would re-surface every review on the
   * site after any nav change. Nor is there a crawl id or a timestamp — a review keyed
   * on either would report as changed on every crawl, which is rule 5 inverted.
   */
  it("is the orphan tuple PRD §7.1 names, and nothing else", () => {
    expect(evidenceFields(thankYou)).toEqual([
      'class="orphan"',
      'post_type="page"',
      "status=200",
    ]);
  });

  it("is the broken link's status and blast radius, and nothing else", () => {
    expect(evidenceFields(integrityIdol)).toEqual(["status=404", "blast_radius=18"]);
  });

  /**
   * A page the crawl never fetched has no status, and a URL no source named has no post
   * type. Both are absences, and both have to be told apart from a page whose post type
   * is literally the word "null" — otherwise two different findings share a digest and
   * one of them silently inherits the other's review.
   */
  it("tells an absent field apart from the string that spells it", () => {
    const neverFetched = evidenceDigest({
      ...thankYou,
      postType: null,
      statusCode: null,
    });
    const spelled = evidenceDigest({ ...thankYou, postType: "null", statusCode: null });
    expect(neverFetched).not.toBe(spelled);
  });
});

describe("evidenceDigest", () => {
  /**
   * **Pinned to a literal, because the digests are stored data.** Every review in the
   * estate holds one, and they are compared against digests computed by whatever code
   * is running now — so a change to the field order, the separator or the kind prefix
   * silently marks every review on every site "changed since review". Computing both
   * sides with the code under test, as every other case here does, cannot see that.
   * These two values were produced by this implementation and are what a stored review
   * of these two findings holds.
   */
  it("is these exact digests, and stays them", () => {
    expect(evidenceDigest(thankYou)).toBe(
      "23b2fb9ea4d3e5a83e0c234e8cb5b4fc21dc26641af95e683ce30faa36759f0a",
    );
    expect(evidenceDigest(integrityIdol)).toBe(
      "01ff1cbce0f46df4e23afe2bdb3d61288c65c3dd6de63c132e87ca09341422c5",
    );
  });

  it("is deterministic and one fixed length, whatever the kind", () => {
    expect(evidenceDigest(thankYou)).toBe(evidenceDigest({ ...thankYou }));
    // Fixed length whatever the kind, so the column shape cannot depend on the tuple.
    expect(evidenceDigest(thankYou)).toMatch(/^[0-9a-f]{64}$/);
    expect(evidenceDigest(integrityIdol)).toMatch(/^[0-9a-f]{64}$/);
  });

  /** PRD §7.1 rule 5's own example: 18 → 40 must not stay quiet. */
  it("changes when a broken link's blast radius moves 18 → 40", () => {
    expect(evidenceDigest({ ...integrityIdol, blastRadius: 40 })).not.toBe(
      evidenceDigest(integrityIdol),
    );
  });

  /**
   * The same evidence, built from scratch rather than copied — which is what a re-crawl
   * produces: a fresh row out of the database, not the object the review was written
   * from.
   */
  it("does not change when the same broken link is re-crawled unchanged", () => {
    expect(
      evidenceDigest({
        kind: "broken_internal_link",
        statusCode: 404,
        blastRadius: 18,
      }),
    ).toBe(evidenceDigest(integrityIdol));
  });

  it("changes when a broken link's status moves", () => {
    expect(evidenceDigest({ ...integrityIdol, statusCode: 410 })).not.toBe(
      evidenceDigest(integrityIdol),
    );
  });

  /**
   * Each field of the tuple, one at a time. `class` is included for completeness of the
   * rule rather than as a case the read path can reach: `listOrphanFindings` selects
   * `class = 'orphan'`, so a page whose class moved is not this finding any more.
   */
  it("changes on each field of the orphan tuple", () => {
    const digest = evidenceDigest(thankYou);
    expect(evidenceDigest({ ...thankYou, statusCode: 404 })).not.toBe(digest);
    expect(evidenceDigest({ ...thankYou, postType: "post" })).not.toBe(digest);
    expect(evidenceDigest({ ...thankYou, class: "excluded" })).not.toBe(digest);
  });

  /**
   * The kind is part of the digested string, so the same subject reviewed under both
   * kinds cannot carry one digest into the other's evidence check. The unique key
   * already keeps the rows apart; this keeps their evidence apart too.
   */
  it("separates the two kinds even when their tuples would read alike", () => {
    expect(
      evidenceDigest({ kind: "broken_internal_link", statusCode: 200, blastRadius: 1 }),
    ).not.toBe(
      evidenceDigest({
        kind: "orphan",
        class: "orphan",
        postType: null,
        statusCode: 200,
      }),
    );
  });
});
