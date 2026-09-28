/**
 * `reviewsFor` against real Postgres — this package's own test entry point, which
 * engineering guide §4.3 requires to run without any other service. Everything else
 * here is pure and covered by the unit tier; this is the one function that reads.
 *
 * What it has to get right is the isolation: a map keyed by subject, holding this site's
 * reviews of this kind and nothing else. A leak across kinds would silence a broken link
 * because its target had been judged as an orphan.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTempDatabase,
  runMigrations,
  upsertFindingReview,
  upsertSite,
  type SiteRow,
  type TempDatabase,
} from "@link-graph/db";
import { reviewsFor } from "./reviews.js";

let db: TempDatabase;
beforeAll(async () => {
  db = await createTempDatabase("reviewsfor");
  await runMigrations(db.pool);
});
afterAll(async () => {
  await db.drop();
});

let sequence = 0;
const at = new Date("2026-09-02T12:00:00Z");
const SUBJECT = "https://integrity.com/agents/thank-you/";

async function newSite(): Promise<SiteRow> {
  return upsertSite(db.pool, {
    siteId: `integrity-com-${sequence++}`,
    canonicalHost: "integrity.com",
    aliases: ["integrity.com"],
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

describe("reviewsFor", () => {
  it("returns this site's reviews of this kind, keyed by subject", async () => {
    const site = await newSite();
    const other = await newSite();
    await upsertFindingReview(db.pool, {
      siteId: site.id,
      kind: "orphan",
      subject: SUBJECT,
      state: "intentional",
      note: "reached after form submit",
      evidenceDigest: "a".repeat(64),
      reviewedBy: "smile",
      reviewedAt: at,
    });
    // The same subject, the other kind — and the same subject on another site. Neither
    // may appear in the map below.
    await upsertFindingReview(db.pool, {
      siteId: site.id,
      kind: "broken_internal_link",
      subject: SUBJECT,
      state: "acknowledged",
      note: "the funnel step is gone",
      evidenceDigest: "b".repeat(64),
      reviewedBy: "dave",
      reviewedAt: at,
    });
    await upsertFindingReview(db.pool, {
      siteId: other.id,
      kind: "orphan",
      subject: SUBJECT,
      state: "acknowledged",
      note: "another site entirely",
      evidenceDigest: "c".repeat(64),
      reviewedBy: "dave",
      reviewedAt: at,
    });

    const orphans = await reviewsFor(db.pool, site.id, "orphan");
    expect([...orphans.keys()]).toEqual([SUBJECT]);
    expect(orphans.get(SUBJECT)).toMatchObject({
      state: "intentional",
      reviewedBy: "smile",
      evidenceDigest: "a".repeat(64),
    });

    const broken = await reviewsFor(db.pool, site.id, "broken_internal_link");
    expect(broken.get(SUBJECT)).toMatchObject({ state: "acknowledged" });
  });

  /**
   * An empty map, not an error: a site nobody has reviewed is the ordinary case, and its
   * report is then all-new rather than unprintable.
   */
  it("is empty for a site with no reviews", async () => {
    const site = await newSite();
    expect((await reviewsFor(db.pool, site.id, "orphan")).size).toBe(0);
  });
});
