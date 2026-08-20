/**
 * The repository functions that no fixture exercises: the tables written by steps
 * later than this one (registry health, external URL checks, metrics, diffs). They
 * are thin by design, so what these tests prove is that the column list and the
 * types line up with the migration — the one thing a hand-written SQL string gets
 * wrong silently.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixture, parseCrawlFixture } from "./fixture.js";
import { runMigrations } from "./migrate.js";
import { insertCrawlDiff, listCrawlDiffs } from "./repo/crawl-diffs.js";
import {
  findCrawlMetrics,
  upsertCrawlMetrics,
  type CrawlMetricsInput,
} from "./repo/crawl-metrics.js";
import { findCrawl, insertCrawl } from "./repo/crawls.js";
import { findExternalUrl, upsertExternalUrl } from "./repo/external-urls.js";
import { insertLinks } from "./repo/links.js";
import { insertRegistryHealth, listRegistryHealth } from "./repo/registry-health.js";
import { findSiteBySlug, upsertSite } from "./repo/sites.js";
import { createTempDatabase, type TempDatabase } from "./testing/temp-database.js";

let db: TempDatabase;
let siteId: number;
let crawlId: number;

beforeAll(async () => {
  db = await createTempDatabase("repo");
  await runMigrations(db.pool);
  const loaded = await loadFixture(
    db.pool,
    parseCrawlFixture({
      site: {
        siteId: "integrity-com",
        canonicalHost: "integrity.com",
        aliases: ["integrity.com", "www.integrity.com"],
        truthSource: "rest",
        ignorePaths: ["/wp-content/"],
        stageHost: "aging01.imgwebhost.com",
      },
      crawl: { status: "complete", startedAt: "2026-08-20T09:00:00.000Z" },
      pages: [
        {
          url: "https://integrity.com/",
          statusCode: 200,
          inTruthSource: true,
          indexable: true,
        },
      ],
      links: [
        {
          from: "https://integrity.com/",
          to: "https://www.integritymarketing.com/",
          anchor: "Integrity Marketing",
          container: "footer",
        },
      ],
    }),
  );
  siteId = loaded.siteId;
  crawlId = loaded.crawlId;
});
afterAll(async () => {
  await db.drop();
});

describe("sites", () => {
  it("round-trips every column, including the array ones", async () => {
    const site = await findSiteBySlug(db.pool, "integrity-com");
    expect(site).toMatchObject({
      id: siteId,
      siteId: "integrity-com",
      canonicalHost: "integrity.com",
      aliases: ["integrity.com", "www.integrity.com"],
      stageHost: "aging01.imgwebhost.com",
      enabled: true,
      truthSource: "rest",
      crawlerMode: "http",
      rateLimit: 1,
      ignorePaths: ["/wp-content/"],
    });
  });

  it("returns null for a slug it does not have", async () => {
    expect(await findSiteBySlug(db.pool, "nope-com")).toBeNull();
  });

  it("updates in place on a second upsert of the same slug", async () => {
    const before = await findSiteBySlug(db.pool, "integrity-com");
    const after = await upsertSite(db.pool, { ...before!, enabled: false });
    expect(after.id).toBe(before!.id);
    expect(after.enabled).toBe(false);
    await upsertSite(db.pool, before!);
  });

  it("stores a truth source that has not been resolved as null, not as none", async () => {
    const site = await upsertSite(db.pool, {
      siteId: "unresolved-com",
      canonicalHost: "unresolved.com",
      aliases: ["unresolved.com"],
      stageHost: null,
      enabled: false,
      truthSource: null,
      crawlerMode: "http",
      rateLimit: 1,
      ignorePaths: [],
    });
    expect(site.truthSource).toBeNull();
  });
});

describe("registry_health", () => {
  it("keeps one row per probe, newest first", async () => {
    await insertRegistryHealth(db.pool, {
      siteId,
      checkedAt: new Date("2026-08-19T00:00:00.000Z"),
      // Distinct from `serves` and `platformSig` on purpose — see the assertion.
      dnsOk: false,
      serves: true,
      platformSig: true,
      versionTxt: "1.6.8",
    });
    await insertRegistryHealth(db.pool, {
      siteId,
      checkedAt: new Date("2026-08-20T00:00:00.000Z"),
      dnsOk: true,
      serves: false,
      platformSig: false,
      versionTxt: null,
    });
    const rows = await listRegistryHealth(db.pool, siteId);
    // Every boolean, not just `serves`: dns_ok and platform_sig are adjacent columns
    // of the same type, so a swapped pair in the INSERT is invisible unless both are
    // read back at differing values. PRD §3.1's drift report keys on platform_sig.
    expect(rows).toEqual([
      {
        siteId,
        checkedAt: new Date("2026-08-20T00:00:00.000Z"),
        dnsOk: true,
        serves: false,
        platformSig: false,
        versionTxt: null,
      },
      {
        siteId,
        checkedAt: new Date("2026-08-19T00:00:00.000Z"),
        dnsOk: false,
        serves: true,
        platformSig: true,
        versionTxt: "1.6.8",
      },
    ]);
  });
});

describe("external_urls", () => {
  it("is keyed by URL and shared across sites, so a recheck replaces the row", async () => {
    const url = "https://www.integritymarketing.com/";
    await upsertExternalUrl(db.pool, {
      urlNormalized: url,
      lastChecked: null,
      statusCode: null,
      unverified: false,
    });
    expect(await findExternalUrl(db.pool, url)).toEqual({
      urlNormalized: url,
      lastChecked: null,
      statusCode: null,
      unverified: false,
    });
    await upsertExternalUrl(db.pool, {
      urlNormalized: url,
      lastChecked: new Date("2026-08-20T10:00:00.000Z"),
      statusCode: 403,
      unverified: true,
    });
    const checked = await findExternalUrl(db.pool, url);
    expect([checked?.statusCode, checked?.unverified]).toEqual([403, true]);
    const { rows } = await db.pool.query<{ n: number }>(
      `SELECT count(*) AS n FROM external_urls`,
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe("links", () => {
  it("refuses an edge whose page belongs to a different crawl", async () => {
    // links.crawl_id is denormalized from pages.crawl_id, and a mismatch would move
    // an edge into another crawl's aggregates without breaking anything visibly.
    const other = await loadFixture(
      db.pool,
      parseCrawlFixture({
        site: {
          siteId: "lionstreet-com",
          canonicalHost: "lionstreet.com",
          aliases: ["lionstreet.com"],
          truthSource: "sitemap",
        },
        crawl: { status: "complete", startedAt: "2026-08-20T09:00:00.000Z" },
        pages: [
          {
            url: "https://lionstreet.com/",
            statusCode: 200,
            inTruthSource: true,
            indexable: true,
          },
        ],
        links: [],
      }),
    );
    const { rows } = await db.pool.query<{ id: number }>(
      `SELECT id FROM pages WHERE crawl_id = $1`,
      [other.crawlId],
    );
    await expect(
      insertLinks(db.pool, crawlId, [
        {
          fromPageId: rows[0]!.id,
          toUrlNormalized: "https://integrity.com/",
          toPageId: null,
          anchor: "Home",
          rel: null,
          isExternal: false,
          isBoilerplate: null,
          container: "header",
          domIndex: 0,
        },
      ]),
    ).rejects.toThrow(/violates foreign key constraint/);
  });
});

describe("crawl_metrics", () => {
  const metrics = (overrides: Partial<CrawlMetricsInput> = {}): CrawlMetricsInput => ({
    crawlId,
    orphans: 3,
    softOrphans: 1,
    linked: 40,
    excluded: 12,
    notInTruthSource: 2,
    undetectable: 0,
    unreachable: 3,
    broken: 0,
    internalUnresolved: 431,
    external: 7,
    boilerplateThresholdPct: 60,
    ...overrides,
  });

  /**
   * Every column is different between the two writes, not just one: the whole reason
   * this is an upsert is that re-running analyse replaces a crawl's numbers, and a SET
   * clause missing from the conflict target leaves one stale number behind — which reads
   * as a real change when step 13 diffs two crawls.
   */
  it("upserts every column, so re-running analyse replaces a crawl's numbers", async () => {
    await upsertCrawlMetrics(db.pool, metrics());
    const second: CrawlMetricsInput = {
      crawlId,
      orphans: 2,
      softOrphans: 4,
      linked: 41,
      excluded: 13,
      notInTruthSource: 3,
      undetectable: 1,
      unreachable: 5,
      broken: 6,
      internalUnresolved: 430,
      external: 8,
      boilerplateThresholdPct: 50,
    };
    await upsertCrawlMetrics(db.pool, second);
    expect(await findCrawlMetrics(db.pool, crawlId)).toEqual(second);
  });

  /**
   * PRD §2: a site with no truth source reports the orphan counters as unknown, never as
   * zero. 005_analysis.sql keeps the two null together, because one known and the other
   * not is a bookkeeping bug rather than a fact about a site.
   */
  it("stores unknown orphan counters as null, and refuses one null without the other", async () => {
    await expect(upsertCrawlMetrics(db.pool, metrics({ orphans: null }))).rejects.toThrow(
      /crawl_metrics_orphans_known_together/,
    );
    await upsertCrawlMetrics(db.pool, metrics({ orphans: null, softOrphans: null }));
    expect(await findCrawlMetrics(db.pool, crawlId)).toMatchObject({
      orphans: null,
      softOrphans: null,
      // Still counted: a noindex page is excluded whether or not an inventory exists.
      excluded: 12,
    });
  });
});

/**
 * The CHECK constraints from `006_truth_source.sql`. They duplicate the cross-field
 * rules in `parseCrawlFixture`, and every other test reaches the table through that
 * parser — so without this the SQL is never asked to reject anything, and a typo in the
 * `(total IS NULL) = (both per-source NULL)` biconditional would be invisible.
 */
describe("crawls truth-source counts", () => {
  const crawl = (
    truthSourceUrls: number | null,
    truthSourceRestUrls: number | null,
    truthSourceSitemapUrls: number | null,
  ) =>
    insertCrawl(db.pool, {
      siteId,
      env: "prod",
      startedAt: new Date("2026-08-20T09:00:00.000Z"),
      finishedAt: null,
      status: "complete",
      deployedTag: null,
      registrySha: null,
      pagesSeen: 0,
      wasThrottled: false,
      truthSourceUrls,
      truthSourceRestUrls,
      truthSourceSitemapUrls,
    });

  it("stores a union of the two sources, and reads all three back", async () => {
    // integrity.com's `page` post type, measured: REST 124, sitemap 96, union 124.
    const row = await crawl(124, 124, 96);
    expect(await findCrawl(db.pool, row.id)).toMatchObject({
      truthSourceUrls: 124,
      truthSourceRestUrls: 124,
      truthSourceSitemapUrls: 96,
    });
  });

  it("accepts one source alone, and no source at all", async () => {
    expect((await crawl(13, null, 13)).truthSourceUrls).toBe(13);
    expect((await crawl(null, null, null)).truthSourceUrls).toBeNull();
  });

  it("refuses an inventory of nothing", async () => {
    await expect(crawl(0, null, 0)).rejects.toThrow(/truth_source_urls_positive/);
  });

  it("refuses a union with no source behind it, and a source with no union", async () => {
    await expect(crawl(13, null, null)).rejects.toThrow(/counts_agree/);
    await expect(crawl(null, 13, null)).rejects.toThrow(/counts_agree/);
  });

  it("refuses a union smaller than a source or larger than their sum", async () => {
    await expect(crawl(96, 124, 96)).rejects.toThrow(/counts_agree/);
    await expect(crawl(300, 124, 96)).rejects.toThrow(/counts_agree/);
  });
});

describe("crawl_diffs", () => {
  it("records what changed between two crawls, in the right direction", async () => {
    // Two distinct crawl ids, and both read back. With from and to set to the same
    // id — or asserted only on kind/url/detail — swapping the two columns in the
    // INSERT and again in the SELECT aliases would pass, and step 13 would report
    // "orphan appeared" against the wrong end of the comparison.
    const later = await insertCrawl(db.pool, {
      siteId,
      env: "prod",
      startedAt: new Date("2026-08-27T09:00:00.000Z"),
      finishedAt: null,
      status: "running",
      deployedTag: "v1.7.0",
      registrySha: null,
      pagesSeen: 0,
      wasThrottled: false,
      truthSourceUrls: null,
      truthSourceRestUrls: null,
      truthSourceSitemapUrls: null,
    });
    await insertCrawlDiff(db.pool, {
      fromCrawlId: crawlId,
      toCrawlId: later.id,
      kind: "orphan_appeared",
      url: "https://integrity.com/promotion/2026-summer/",
      detail: "v1.6.8 -> v1.7.0",
    });

    expect(await listCrawlDiffs(db.pool, later.id)).toEqual([
      {
        id: expect.any(Number) as number,
        fromCrawlId: crawlId,
        toCrawlId: later.id,
        kind: "orphan_appeared",
        url: "https://integrity.com/promotion/2026-summer/",
        detail: "v1.6.8 -> v1.7.0",
      },
    ]);
    // ...and the filter really is on to_crawl_id.
    expect(await listCrawlDiffs(db.pool, crawlId)).toEqual([]);
  });
});
