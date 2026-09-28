/**
 * `finding_reviews` against real Postgres (`011`): the constraints PRD §7.1's rules are
 * written down as, and the one behaviour of the table that outlives everything else — a
 * review keyed on `(site_id, kind, subject)` survives the crawl that produced its
 * finding.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../testing/temp-database.js";
import { runMigrations } from "../migrate.js";
import { insertCrawl } from "./crawls.js";
import { upsertSite, type SiteRow } from "./sites.js";
import {
  findFindingReview,
  listFindingReviews,
  upsertFindingReview,
  type FindingReviewInput,
} from "./finding-reviews.js";
import { someFindingReviewInput } from "../testing/reviews.js";

let db: TempDatabase;
beforeAll(async () => {
  db = await createTempDatabase("reviews");
  await runMigrations(db.pool);
});
afterAll(async () => {
  await db.drop();
});

const at = new Date("2026-09-02T12:00:00Z");
let sequence = 0;

async function newSite(): Promise<SiteRow> {
  return upsertSite(db.pool, {
    siteId: `integrity-com-${sequence++}`,
    canonicalHost: "integrity.com",
    aliases: ["integrity.com", "www.integrity.com"],
    stageHost: null,
    enabled: true,
    truthSource: "rest",
    crawlerMode: "http",
    crawlScope: "full",
    sampleCeiling: null,
    rateLimit: 1,
    ignorePaths: [],
    redirectTargetHost: null,
  });
}

/**
 * The shared builder, on a real `sites` row. Its defaults are one of the 16
 * correct-and-intentional findings step 7's gate found (PRD §2).
 */
const review = (site: SiteRow, over: Partial<FindingReviewInput> = {}) =>
  someFindingReviewInput({ siteId: site.id, reviewedAt: at, ...over });

describe("finding_reviews", () => {
  it("stores a review and reads it back by subject", async () => {
    const site = await newSite();
    const written = await upsertFindingReview(db.pool, review(site));
    expect(written).toMatchObject({
      kind: "orphan",
      subject: "https://integrity.com/agents/thank-you/",
      state: "intentional",
      note: "reached after form submit",
      reviewedBy: "smile",
    });
    expect(written.reviewedAt).toEqual(at);
    expect(
      await findFindingReview(db.pool, site.id, "orphan", written.subject),
    ).toMatchObject({ id: written.id });
  });

  /**
   * PRD §7.1 rule 2, and the reason the table is keyed the way it is. `pages` and
   * `links` rows belong to one crawl and are rolled up after twelve of them (PRD §7),
   * so a note keyed on one would evaporate on schedule — silently, and only for the
   * findings somebody had bothered to judge.
   */
  it("survives the deletion of the crawl its finding was recorded in", async () => {
    const site = await newSite();
    const crawl = await insertCrawl(db.pool, {
      siteId: site.id,
      env: "prod",
      startedAt: at,
      finishedAt: at,
      status: "complete",
      deployedTag: null,
      registrySha: null,
      pagesSeen: 1,
      wasThrottled: false,
      truthSourceUrls: 1,
      truthSourceRestUrls: 1,
      truthSourceSitemapUrls: null,
      taxonomies: [],
    });
    await upsertFindingReview(db.pool, review(site));

    await db.pool.query(`DELETE FROM crawls WHERE id = $1`, [crawl.id]);

    expect(await listFindingReviews(db.pool, site.id, "orphan")).toHaveLength(1);
  });

  /**
   * Re-judging a finding replaces the judgement rather than adding a second one. Two
   * rows for one finding would make "is this reviewed?" depend on which row a query
   * happened to see.
   */
  it("replaces the review for a subject rather than adding a second", async () => {
    const site = await newSite();
    const first = await upsertFindingReview(db.pool, review(site));
    const second = await upsertFindingReview(
      db.pool,
      review(site, {
        state: "acknowledged",
        note: "actually a defect: the funnel step is linked from nowhere",
        evidenceDigest: "b".repeat(64),
        reviewedBy: "dave",
      }),
    );

    expect(second.id).toBe(first.id);
    const rows = await listFindingReviews(db.pool, site.id, "orphan");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "acknowledged", reviewedBy: "dave" });
  });

  it("keeps the two kinds apart for one subject", async () => {
    const site = await newSite();
    await upsertFindingReview(db.pool, review(site));
    await upsertFindingReview(
      db.pool,
      review(site, { kind: "broken_internal_link", note: "the target is gone for good" }),
    );

    expect(await listFindingReviews(db.pool, site.id, "orphan")).toHaveLength(1);
    expect(
      await listFindingReviews(db.pool, site.id, "broken_internal_link"),
    ).toHaveLength(1);
  });

  /**
   * PRD §7.1 rule 4: **there is no `fixed` state.** A fixed orphan gains an inbound link
   * and the next crawl stops reporting it; a hand-written "fixed" would let a stale
   * human claim outrank a live measurement, which is engineering guide §1 pointing the
   * wrong way. The TS union refuses it at compile time — this is the other copy, the one
   * that also refuses `psql`.
   */
  it("refuses a state of 'fixed', at the constraint", async () => {
    const site = await newSite();
    await expect(
      db.pool.query(
        `INSERT INTO finding_reviews
           (site_id, kind, subject, state, note, evidence_digest, reviewed_by,
            reviewed_at)
         VALUES ($1, 'orphan', 'https://integrity.com/test/', 'fixed', 'someone fixed it',
                 'digest', 'smile', $2)`,
        [site.id, at],
      ),
    ).rejects.toThrow(/finding_reviews_state_check/);
  });

  it("refuses a kind of 'fixed', and any other kind not in the vocabulary", async () => {
    const site = await newSite();
    await expect(
      db.pool.query(
        `INSERT INTO finding_reviews
           (site_id, kind, subject, state, note, evidence_digest, reviewed_by,
            reviewed_at)
         VALUES ($1, 'fixed', 'https://integrity.com/test/', 'acknowledged', 'note',
                 'digest', 'smile', $2)`,
        [site.id, at],
      ),
    ).rejects.toThrow(/finding_reviews_kind_check/);
  });

  /**
   * PRD §2 defines a reviewed finding as one a human has judged **with a note**. A blank
   * one ranks a finding out of the new list while recording no reason for it, which is
   * the row nobody can audit a year later.
   */
  /**
   * A blank note, in each of the three ways a blank arrives. **The tab and the newline
   * are the cases the obvious CHECK misses**: measured on postgres 18.6,
   * `btrim(E'\t') = ''` is false, so one-argument `btrim` accepts a tab-only note —
   * which is why `011` names the whitespace set.
   */
  it("refuses a blank note, whichever whitespace it is made of", async () => {
    const site = await newSite();
    for (const note of ["   ", "\t", "\n\n"]) {
      await expect(
        upsertFindingReview(db.pool, review(site, { note })),
        JSON.stringify(note),
      ).rejects.toThrow(/finding_reviews_note_check/);
    }
  });

  it("refuses a blank subject, which is the key the table rests on", async () => {
    const site = await newSite();
    await expect(
      upsertFindingReview(db.pool, review(site, { subject: " " })),
    ).rejects.toThrow(/finding_reviews_subject_check/);
  });
});
