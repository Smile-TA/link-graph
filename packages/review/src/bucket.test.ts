/**
 * The three-way split (PRD §9, §7.1): new / changed since review / reviewed.
 *
 * The subjects are four of the 16 correct-and-intentional findings step 7's gate found
 * on integrity.com — the case §7.1 exists for.
 */
import { describe, expect, it } from "vitest";
import { someFindingReview, type FindingReviewRow } from "@link-graph/db";
import { bucketFindings, countBuckets, countStates, type Finding } from "./bucket.js";
import { evidenceDigest, type OrphanEvidence } from "./evidence.js";

const HOST = "https://integrity.com";
const PATHS = [
  "/agents/thank-you/",
  "/nationaldogday/",
  "/preneed/thank-you/",
  "/springtraining/",
];

const orphan = (path: string, over: Partial<OrphanEvidence> = {}): Finding => ({
  subject: `${HOST}${path}`,
  evidence: {
    kind: "orphan",
    class: "orphan",
    postType: "page",
    statusCode: 200,
    ...over,
  },
});

const FINDINGS = PATHS.map((path) => orphan(path));

let id = 0;
/** The shared row builder, aimed at one of these findings and its current evidence. */
const review = (
  finding: Finding,
  over: Partial<FindingReviewRow> = {},
): FindingReviewRow =>
  someFindingReview({
    id: ++id,
    subject: finding.subject,
    evidenceDigest: evidenceDigest(finding.evidence),
    ...over,
  });

const reviewsOf = (...rows: readonly FindingReviewRow[]) =>
  new Map(rows.map((row) => [row.subject, row]));

describe("bucketFindings", () => {
  it("calls a finding with no review new", () => {
    const bucketed = bucketFindings(FINDINGS, new Map());
    expect(bucketed.map((b) => b.bucket)).toEqual(["new", "new", "new", "new"]);
    expect(bucketed.every((b) => b.review === null)).toBe(true);
  });

  it("calls a finding whose evidence still matches its review reviewed", () => {
    const first = FINDINGS[0];
    if (first === undefined) throw new Error("no findings");
    const bucketed = bucketFindings(FINDINGS, reviewsOf(review(first)));
    expect(bucketed.map((b) => b.bucket)).toEqual(["reviewed", "new", "new", "new"]);
    expect(bucketed[0]?.review?.note).toBe("reached after form submit");
  });

  /** Rule 5: changed evidence re-surfaces the finding, ranked with the new ones. */
  it("calls a finding whose evidence has moved changed", () => {
    const first = FINDINGS[0];
    if (first === undefined) throw new Error("no findings");
    // Reviewed when the page returned 200; it now 404s.
    const stale = review(first, {
      evidenceDigest: evidenceDigest({ ...first.evidence, statusCode: 404 }),
    });
    const bucketed = bucketFindings(FINDINGS, reviewsOf(stale));
    expect(bucketed[0]?.bucket).toBe("changed");
    // The review is still carried, so the report can print who judged it and when.
    expect(bucketed[0]?.review?.reviewedBy).toBe("smile");
  });

  /**
   * Engineering guide §1 in the shape this step is about: the split must not lose a
   * finding. Whatever the reviews say, the three buckets account for every measured
   * finding and for nothing else.
   */
  it("keeps the measured total whole, whatever the reviews say", () => {
    const [a, b] = FINDINGS;
    if (a === undefined || b === undefined) throw new Error("no findings");
    const reviews = reviewsOf(
      review(a),
      review(b, { evidenceDigest: "a digest of something else" }),
      // A review whose subject is not a finding of this crawl — the orphan was fixed,
      // or the page was deleted. It must not add a row and must not add to a count.
      review(orphan("/valero-open-giveaway/")),
    );
    const bucketed = bucketFindings(FINDINGS, reviews);
    expect(bucketed).toHaveLength(FINDINGS.length);
    expect(bucketed.map((row) => row.finding.subject)).toEqual(
      FINDINGS.map((f) => f.subject),
    );
    const counts = countBuckets(bucketed);
    expect(counts.new + counts.changed + counts.reviewed).toBe(FINDINGS.length);
    expect(counts).toEqual({ new: 2, changed: 1, reviewed: 1 });
  });

  it("preserves the order it was given, which is the order a reader sorted by", () => {
    const bucketed = bucketFindings(FINDINGS, new Map());
    expect(bucketed.map((row) => row.finding.subject)).toEqual(
      FINDINGS.map((f) => f.subject),
    );
  });
});

describe("countBuckets", () => {
  /**
   * All three counts, always — PRD §9. A tally built by counting what is present would
   * print two counts on a site where no finding is new, and "0 new" is exactly the line
   * a reader needs to see.
   */
  it("names all three buckets even when nothing is in two of them", () => {
    const bucketed = bucketFindings(
      FINDINGS,
      reviewsOf(...FINDINGS.map((finding) => review(finding))),
    );
    expect(countBuckets(bucketed)).toEqual({ new: 0, changed: 0, reviewed: 4 });
  });

  it("counts an empty finding set as three zeros rather than nothing", () => {
    expect(countBuckets([])).toEqual({ new: 0, changed: 0, reviewed: 0 });
  });
});

describe("countStates", () => {
  /**
   * Rule 3: the intentional/acknowledged split is the only number a reader gets out of
   * reviewing — how much of the backlog is deliberate versus outstanding — so both
   * states are always named.
   */
  it("splits the reviewed findings by what their review claims", () => {
    const [a, b, c] = FINDINGS;
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error("no findings");
    }
    const bucketed = bucketFindings(
      FINDINGS,
      reviewsOf(
        review(a),
        review(b, { state: "acknowledged" }),
        review(c, { state: "acknowledged" }),
      ),
    );
    expect(countStates(bucketed)).toEqual({ intentional: 1, acknowledged: 2 });
  });

  /**
   * A `changed` finding's review is stale evidence, and counting it as backlog would
   * claim a judgement that has been overtaken. It ranks with the new ones (rule 5), so
   * it counts with neither state.
   */
  it("does not count a review whose evidence has moved", () => {
    const first = FINDINGS[0];
    if (first === undefined) throw new Error("no findings");
    const bucketed = bucketFindings(
      FINDINGS,
      reviewsOf(review(first, { evidenceDigest: "stale" })),
    );
    expect(countStates(bucketed)).toEqual({ intentional: 0, acknowledged: 0 });
  });
});
