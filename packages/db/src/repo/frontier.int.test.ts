/**
 * `crawl_frontier` against real Postgres — the refusals the crawler's resume rests on.
 *
 * The crawl loop itself is covered end to end in `packages/crawl`; what is here is the
 * behaviour that only shows up at the edges: a URL queued twice, a page row written
 * twice, and the constraint that keeps "failed and still pending" distinguishable from
 * "succeeded later".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../testing/temp-database.js";
import { runMigrations } from "../migrate.js";
import { insertCrawl } from "./crawls.js";
import { upsertSite } from "./sites.js";
import {
  addToFrontier,
  countFrontier,
  markFrontierFetched,
  nextFrontierUrl,
  recordFrontierFailure,
} from "./frontier.js";

let db: TempDatabase;
beforeAll(async () => {
  db = await createTempDatabase("frontier");
  await runMigrations(db.pool);
});
afterAll(async () => {
  await db.drop();
});

const at = new Date("2026-08-20T12:00:00Z");
let sequence = 0;

async function newCrawl(): Promise<number> {
  const site = await upsertSite(db.pool, {
    siteId: `frontier-${sequence++}`,
    canonicalHost: "403bplan.net",
    aliases: ["403bplan.net"],
    stageHost: null,
    enabled: true,
    truthSource: "sitemap",
    crawlerMode: "http",
    crawlScope: "full",
    sampleCeiling: null,
    rateLimit: 1,
    ignorePaths: [],
  });
  const crawl = await insertCrawl(db.pool, {
    siteId: site.id,
    env: "prod",
    startedAt: at,
    finishedAt: null,
    status: "running",
    deployedTag: null,
    registrySha: null,
    pagesSeen: 0,
    wasThrottled: false,
    truthSourceUrls: 13,
    truthSourceRestUrls: null,
    truthSourceSitemapUrls: 13,
    taxonomies: [],
  });
  return crawl.id;
}

describe("crawl_frontier", () => {
  it("hands URLs back in insertion order, which is what makes a crawl repeatable", async () => {
    const crawlId = await newCrawl();
    const urls = ["https://403bplan.net/", "https://403bplan.net/contact-us/"];
    await addToFrontier(
      db.pool,
      crawlId,
      urls.map((urlNormalized) => ({
        urlNormalized,
        inTruthSource: true,
        postType: null,
      })),
    );
    expect((await nextFrontierUrl(db.pool, crawlId))?.urlNormalized).toBe(urls[0]);
    await markFrontierFetched(db.pool, crawlId, urls[0] ?? "", at);
    expect((await nextFrontierUrl(db.pool, crawlId))?.urlNormalized).toBe(urls[1]);
    await markFrontierFetched(db.pool, crawlId, urls[1] ?? "", at);
    expect(await nextFrontierUrl(db.pool, crawlId)).toBeNull();
    expect(await countFrontier(db.pool, crawlId)).toEqual({
      total: 2,
      fetched: 2,
      pending: 0,
      failed: 0,
    });
  });

  it("keeps the first answer when a seed is discovered again as a link", async () => {
    // The seed says the truth source lists this page; a link from another page says
    // nothing about that. Letting the second write win would take the page out of the
    // orphan set difference (PRD §2) because nothing links to what nobody listed.
    const crawlId = await newCrawl();
    const url = "https://403bplan.net/newsletters/";
    expect(
      await addToFrontier(db.pool, crawlId, [
        { urlNormalized: url, inTruthSource: true, postType: "page" },
      ]),
    ).toBe(1);
    expect(
      await addToFrontier(db.pool, crawlId, [
        { urlNormalized: url, inTruthSource: false, postType: null },
      ]),
    ).toBe(0);
    // Both facts the truth source supplied survive the second insert: the page is still
    // listed by the inventory, and it is still the post type the inventory named. A
    // link from another page knows neither.
    expect(await nextFrontierUrl(db.pool, crawlId)).toMatchObject({
      inTruthSource: true,
      postType: "page",
    });
  });

  it("refuses to mark a URL fetched twice, so a page row cannot be written twice", async () => {
    const crawlId = await newCrawl();
    const url = "https://403bplan.net/";
    await addToFrontier(db.pool, crawlId, [
      { urlNormalized: url, inTruthSource: true, postType: null },
    ]);
    await markFrontierFetched(db.pool, crawlId, url, at);
    await expect(markFrontierFetched(db.pool, crawlId, url, at)).rejects.toThrow(
      /no pending frontier entry/,
    );
  });

  it("leaves a failed URL pending, counts the attempt, and clears the error on success", async () => {
    const crawlId = await newCrawl();
    const url = "https://403bplan.net/disclosures/";
    await addToFrontier(db.pool, crawlId, [
      { urlNormalized: url, inTruthSource: true, postType: null },
    ]);
    await recordFrontierFailure(db.pool, crawlId, url, "503, retry-after 3600s");
    expect(await countFrontier(db.pool, crawlId)).toMatchObject({
      pending: 1,
      failed: 1,
    });
    // Still the next URL: the resume picks up exactly where the block stopped it.
    expect(await nextFrontierUrl(db.pool, crawlId)).toMatchObject({ attempts: 1 });

    await markFrontierFetched(db.pool, crawlId, url, at);
    const row = await db.pool.query<{ attempts: number; last_error: string | null }>(
      `SELECT attempts, last_error FROM crawl_frontier WHERE crawl_id = $1`,
      [crawlId],
    );
    // Two attempts, and no error left behind to be read as a still-failing URL.
    expect(row.rows[0]).toEqual({ attempts: 2, last_error: null });
  });

  it("refuses a fetched row that still carries an error", async () => {
    const crawlId = await newCrawl();
    await addToFrontier(db.pool, crawlId, [
      { urlNormalized: "https://403bplan.net/", inTruthSource: true, postType: null },
    ]);
    await expect(
      db.pool.query(
        `UPDATE crawl_frontier SET fetched_at = $2, last_error = 'kept' WHERE crawl_id = $1`,
        [crawlId, at],
      ),
    ).rejects.toThrow(/crawl_frontier_error_means_pending/);
  });
});
