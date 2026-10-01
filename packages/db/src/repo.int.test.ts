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
import {
  insertCrawlDiff,
  listCrawlDiffs,
  listDiffEventsForSubjects,
} from "./repo/crawl-diffs.js";
import {
  findCrawlMetrics,
  upsertCrawlMetrics,
  ORPHANS_UNKNOWN_REASONS,
  type CrawlMetricsInput,
  type OrphansUnknownReason,
} from "./repo/crawl-metrics.js";
import {
  countCrawlRows,
  findCrawl,
  findPreviousCompleteCrawl,
  insertCrawl,
  listCompleteCrawlIds,
  listCrawlSummaries,
  pruneCrawlDetail,
} from "./repo/crawls.js";
import {
  countExternalUrls,
  findExternalUrl,
  listExternalLinksForCrawl,
  listExternalUrlsDue,
  upsertExternalUrl,
  upsertExternalUrls,
} from "./repo/external-urls.js";
import { insertLinks } from "./repo/links.js";
import { listPages, listPagesPage, type PageInput } from "./repo/pages.js";
import { insertRegistryHealth, listRegistryHealth } from "./repo/registry-health.js";
import {
  findSiteBySlug,
  upsertSite,
  type CrawlScope,
  type SiteInput,
} from "./repo/sites.js";
import { insertCompleteCrawl } from "./testing/crawls.js";
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

/**
 * A dedicated site, isolated from the shared fixture `siteId` above — several tests
 * below need to insert their own extra crawls, and doing that against the shared site
 * would shift the crawl-id sequence out from under "step 13"'s ordinal-crawl-id
 * assertions, which run later in this same file against that shared site.
 */
let siteSequence = 0;
async function makeSite(): Promise<number> {
  const slug = `repo-int-extra-${siteSequence++}`;
  const site = await upsertSite(db.pool, {
    siteId: slug,
    canonicalHost: `${slug}.example`,
    aliases: [`${slug}.example`],
    stageHost: null,
    enabled: true,
    truthSource: "sitemap",
    crawlerMode: "http",
    crawlScope: "full",
    sampleCeiling: null,
    rateLimit: 1,
    ignorePaths: [],
    ignoreLinkPatterns: [],
    redirectTargetHost: null,
  });
  return site.id;
}

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
      redirectTargetHost: null,
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
      crawlScope: "full",
      sampleCeiling: null,
      rateLimit: 1,
      ignorePaths: [],
      ignoreLinkPatterns: [],
      redirectTargetHost: null,
    });
    expect(site.truthSource).toBeNull();
  });

  /**
   * PRD §15 and `008_sample_scope.sql`. `sample` with no ceiling is a full crawl
   * wearing the label — it would run to 59,363 pages on agent.familyfirstlife.com while
   * suppressing the orphan count as "sampled" — and a ceiling on a `full` site is a
   * limit nothing enforces, which reads like one.
   */
  it("refuses a sampled site with no ceiling, and a ceiling on a full crawl", async () => {
    const site = (scope: CrawlScope, ceiling: number | null): SiteInput => ({
      siteId: "templated-com",
      canonicalHost: "templated.com",
      aliases: ["templated.com"],
      stageHost: null,
      enabled: true,
      truthSource: "rest",
      crawlerMode: "http",
      crawlScope: scope,
      sampleCeiling: ceiling,
      rateLimit: 1,
      ignorePaths: [],
      ignoreLinkPatterns: [],
      redirectTargetHost: null,
    });
    await expect(upsertSite(db.pool, site("sample", null))).rejects.toThrow(
      /sites_sample_ceiling_iff_sample/,
    );
    await expect(upsertSite(db.pool, site("full", 500))).rejects.toThrow(
      /sites_sample_ceiling_iff_sample/,
    );
    await expect(upsertSite(db.pool, site("sample", 0))).rejects.toThrow(
      /sample_ceiling/,
    );
    const sampled = await upsertSite(db.pool, site("sample", 500));
    expect(sampled.crawlScope).toBe("sample");
    expect(sampled.sampleCeiling).toBe(500);
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
      redirectsToHost: null,
    });
    await insertRegistryHealth(db.pool, {
      siteId,
      checkedAt: new Date("2026-08-20T00:00:00.000Z"),
      dnsOk: true,
      serves: false,
      platformSig: false,
      versionTxt: null,
      redirectsToHost: null,
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
        redirectsToHost: null,
      },
      {
        siteId,
        checkedAt: new Date("2026-08-19T00:00:00.000Z"),
        dnsOk: false,
        serves: true,
        platformSig: true,
        versionTxt: "1.6.8",
        redirectsToHost: null,
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
      detail: null,
    });
    expect(await findExternalUrl(db.pool, url)).toEqual({
      urlNormalized: url,
      lastChecked: null,
      statusCode: null,
      unverified: false,
      detail: null,
    });
    await upsertExternalUrl(db.pool, {
      urlNormalized: url,
      lastChecked: new Date("2026-08-20T10:00:00.000Z"),
      statusCode: 403,
      unverified: true,
      detail: "HTTP 403: the host refused us access",
    });
    const checked = await findExternalUrl(db.pool, url);
    expect([checked?.statusCode, checked?.unverified]).toEqual([403, true]);
    const { rows } = await db.pool.query<{ n: number }>(
      `SELECT count(*) AS n FROM external_urls`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("writes a whole run in one statement and reports how many rows it wrote", async () => {
    const written = await upsertExternalUrls(db.pool, [
      {
        urlNormalized: "https://a.example.org/",
        lastChecked: new Date("2026-09-02T12:00:00.000Z"),
        statusCode: 200,
        unverified: false,
        detail: null,
      },
      {
        urlNormalized: "https://b.example.org/",
        lastChecked: new Date("2026-09-02T12:00:00.000Z"),
        statusCode: null,
        unverified: true,
        detail: "the request timed out",
      },
    ]);
    expect(written).toBe(2);
    expect(await upsertExternalUrls(db.pool, [])).toBe(0);
  });

  it("lists a crawl's external URLs that are due, and counts them all", async () => {
    // The fixture crawl has one external edge, to www.integritymarketing.com.
    expect(await countExternalUrls(db.pool, crawlId)).toBe(1);
    const cutoff = new Date("2026-09-02T12:00:00.000Z");
    await upsertExternalUrl(db.pool, {
      urlNormalized: "https://www.integritymarketing.com/",
      lastChecked: new Date("2026-09-02T13:00:00.000Z"),
      statusCode: 200,
      unverified: false,
      detail: null,
    });
    expect(await listExternalUrlsDue(db.pool, crawlId, cutoff)).toEqual([]);
    expect(
      await listExternalUrlsDue(db.pool, crawlId, new Date("2026-09-03T00:00:00.000Z")),
    ).toEqual(["https://www.integritymarketing.com/"]);
  });

  it("lists a crawl's external links paginated, worst-first, unchecked included via LEFT JOIN", async () => {
    const crawl = await insertCompleteCrawl(db.pool, await makeSite(), new Date("2026-09-05T00:00:00Z"), {
      pages: [
        {
          urlNormalized: "https://ext-links.example/",
          path: "/",
          postType: null,
          statusCode: 200,
          depth: 0,
          inTruthSource: true,
          indexable: true,
          canonicalTo: null,
          redirectTo: null,
          class: null,
        },
      ],
    });
    const [page] = await listPages(db.pool, crawl.id);
    await insertLinks(db.pool, crawl.id, [
      {
        fromPageId: page!.id,
        toUrlNormalized: "https://ok.example/",
        toPageId: null,
        anchor: "ok",
        rel: null,
        isExternal: true,
        isBoilerplate: null,
        container: "main",
        domIndex: 0,
      },
      {
        fromPageId: page!.id,
        toUrlNormalized: "https://broken.example/",
        toPageId: null,
        anchor: "broken",
        rel: null,
        isExternal: true,
        isBoilerplate: null,
        container: "main",
        domIndex: 1,
      },
      {
        fromPageId: page!.id,
        toUrlNormalized: "https://never-checked.example/",
        toPageId: null,
        anchor: "unchecked",
        rel: null,
        isExternal: true,
        isBoilerplate: null,
        container: "main",
        domIndex: 2,
      },
    ]);
    await upsertExternalUrls(db.pool, [
      {
        urlNormalized: "https://ok.example/",
        lastChecked: new Date("2026-09-05T01:00:00Z"),
        statusCode: 200,
        unverified: false,
        detail: null,
      },
      {
        urlNormalized: "https://broken.example/",
        lastChecked: new Date("2026-09-05T01:00:00Z"),
        statusCode: 404,
        unverified: false,
        detail: null,
      },
    ]);

    const all = await listExternalLinksForCrawl(db.pool, crawl.id, 10, 0);
    expect(all.total).toBe(3);
    // Not-yet-checked first (lastChecked null), then the 404, then the 200 — worst
    // finding on page one, per this function's own ordering comment.
    expect(all.rows.map((r) => r.urlNormalized)).toEqual([
      "https://never-checked.example/",
      "https://broken.example/",
      "https://ok.example/",
    ]);
    expect(all.rows[0]?.lastChecked).toBeNull();
    expect(all.rows[1]?.statusCode).toBe(404);

    const firstPage = await listExternalLinksForCrawl(db.pool, crawl.id, 2, 0);
    expect(firstPage.rows.map((r) => r.urlNormalized)).toEqual([
      "https://never-checked.example/",
      "https://broken.example/",
    ]);
    expect(firstPage.total).toBe(3);
    const secondPage = await listExternalLinksForCrawl(db.pool, crawl.id, 2, 2);
    expect(secondPage.rows.map((r) => r.urlNormalized)).toEqual(["https://ok.example/"]);
  });
});

describe("pages: listPagesPage", () => {
  it("paginates a crawl's pages alphabetically and reports the true total", async () => {
    const pageInput = (path: string): PageInput => ({
      urlNormalized: `https://paginated.example${path}`,
      path,
      postType: null,
      statusCode: 200,
      depth: 0,
      inTruthSource: true,
      indexable: true,
      canonicalTo: null,
      redirectTo: null,
      class: "linked",
    });
    const crawl = await insertCompleteCrawl(db.pool, await makeSite(), new Date("2026-09-06T00:00:00Z"), {
      pages: ["/a/", "/b/", "/c/", "/d/", "/e/"].map(pageInput),
    });

    const firstPage = await listPagesPage(db.pool, crawl.id, 2, 0);
    expect(firstPage.total).toBe(5);
    expect(firstPage.rows.map((r) => r.path)).toEqual(["/a/", "/b/"]);

    const secondPage = await listPagesPage(db.pool, crawl.id, 2, 2);
    expect(secondPage.rows.map((r) => r.path)).toEqual(["/c/", "/d/"]);

    const lastPage = await listPagesPage(db.pool, crawl.id, 2, 4);
    expect(lastPage.rows.map((r) => r.path)).toEqual(["/e/"]);
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
    orphansUnknownReason: null,
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
      orphans: null,
      orphansUnknownReason: "sampled",
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
   * PRD §2 and §15: an orphan count this crawl cannot produce is null, never zero — and
   * never null without saying why, because "no inventory to difference against" and
   * "sampled by policy" are different facts with different remedies.
   * `007_drop_soft_orphan.sql` makes it an equivalence, so both halves are refused.
   */
  it("refuses a null orphan count with no reason, and a reason beside a real count", async () => {
    await expect(upsertCrawlMetrics(db.pool, metrics({ orphans: null }))).rejects.toThrow(
      /crawl_metrics_orphans_null_has_reason/,
    );
    await expect(
      upsertCrawlMetrics(
        db.pool,
        metrics({ orphans: 3, orphansUnknownReason: "sampled" }),
      ),
    ).rejects.toThrow(/crawl_metrics_orphans_null_has_reason/);
  });

  it("stores each reason an orphan count can be unknown", async () => {
    for (const reason of ORPHANS_UNKNOWN_REASONS) {
      await upsertCrawlMetrics(
        db.pool,
        metrics({ orphans: null, orphansUnknownReason: reason }),
      );
      expect(await findCrawlMetrics(db.pool, crawlId)).toMatchObject({
        orphans: null,
        orphansUnknownReason: reason,
        // Still counted: a noindex page is excluded whether or not an inventory exists.
        excluded: 12,
      });
    }
  });

  it("refuses a reason outside the vocabulary", async () => {
    await expect(
      upsertCrawlMetrics(db.pool, {
        ...metrics({ orphans: null }),
        orphansUnknownReason: "partial" as OrphansUnknownReason,
      }),
    ).rejects.toThrow(/orphans_unknown_reason/);
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
      taxonomies: [],
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

describe("crawls: listCrawlSummaries", () => {
  it("aggregates complete-crawl count and latest finished_at, per site, in one query", async () => {
    // A dedicated site rather than the shared fixture `siteId`: other describe blocks
    // in this file insert their own crawls against that one, and an aggregate over
    // "every complete crawl of this site" would otherwise depend on what ran before it.
    const site = await makeSite();
    await insertCompleteCrawl(db.pool, site, new Date("2026-09-01T00:00:00Z"));
    await insertCompleteCrawl(db.pool, site, new Date("2026-09-08T00:00:00Z"));
    // A partial crawl must not count: `listCrawlSummaries` filters to `status =
    // 'complete'`, same as `listCompleteCrawlIds` already does.
    await insertCrawl(db.pool, {
      siteId: site,
      env: "prod",
      startedAt: new Date("2026-09-10T00:00:00Z"),
      finishedAt: null,
      status: "partial",
      deployedTag: null,
      registrySha: null,
      pagesSeen: 0,
      wasThrottled: false,
      truthSourceUrls: null,
      truthSourceRestUrls: null,
      truthSourceSitemapUrls: null,
      taxonomies: [],
    });

    const summaries = await listCrawlSummaries(db.pool);
    const mine = summaries.find((s) => s.siteId === site);
    expect(mine).toEqual({
      siteId: site,
      completeCrawlCount: 2,
      lastFinishedAt: new Date("2026-09-08T00:00:00Z"),
    });
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
      taxonomies: [],
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

describe("step 13: retention and diff history", () => {
  const page = (overrides: Partial<PageInput> = {}): PageInput => ({
    urlNormalized: "https://integrity.com/",
    path: "/",
    postType: null,
    statusCode: 200,
    depth: 0,
    inTruthSource: true,
    indexable: true,
    canonicalTo: null,
    redirectTo: null,
    class: "linked",
    ...overrides,
  });

  async function completeCrawl(finishedAt: string): Promise<number> {
    const crawl = await insertCompleteCrawl(db.pool, siteId, new Date(finishedAt), {
      pages: [page()],
    });
    return crawl.id;
  }

  it("finds the crawl immediately before another, and none before the site's first", async () => {
    // The `beforeAll` fixture already gave this site one complete crawl (`crawlId`),
    // so "none for the first" is proven against that one rather than an empty site.
    expect(await findPreviousCompleteCrawl(db.pool, siteId, crawlId)).toBeNull();

    const first = await completeCrawl("2026-01-01T00:00:00Z");
    const second = await completeCrawl("2026-01-08T00:00:00Z");

    const previous = await findPreviousCompleteCrawl(db.pool, siteId, second);
    expect(previous?.id).toBe(first);
  });

  it("prunes a crawl's pages (and cascades its links) while leaving the row behind", async () => {
    const crawl = await completeCrawl("2026-02-01T00:00:00Z");
    expect((await countCrawlRows(db.pool, crawl)).pages).toBe(1);

    await pruneCrawlDetail(db.pool, [crawl]);

    expect((await countCrawlRows(db.pool, crawl)).pages).toBe(0);
    expect(await findCrawl(db.pool, crawl)).not.toBeNull();
  });

  it("keeps the newest 12 complete crawls in id order and prunes nothing short of that", async () => {
    const ids = await listCompleteCrawlIds(db.pool, siteId);
    // Populated by the two tests above, oldest crawl already pruned or not — either
    // way there are fewer than 12, so nothing here should ever be selected for pruning.
    expect(ids.length).toBeLessThan(12);
  });

  it("reads back appeared/resolved events with the crawl's own finished_at", async () => {
    const a = await completeCrawl("2026-03-01T00:00:00Z");
    const b = await completeCrawl("2026-03-08T00:00:00Z");
    await insertCrawlDiff(db.pool, {
      fromCrawlId: a,
      toCrawlId: b,
      kind: "orphan_resolved",
      url: "https://integrity.com/gone/",
      detail: null,
    });
    const c = await completeCrawl("2026-03-15T00:00:00Z");
    await insertCrawlDiff(db.pool, {
      fromCrawlId: b,
      toCrawlId: c,
      kind: "orphan_appeared",
      url: "https://integrity.com/gone/",
      detail: null,
    });

    const events = await listDiffEventsForSubjects(db.pool, siteId, "orphan", [
      "https://integrity.com/gone/",
    ]);
    expect(events.map((e) => e.kind)).toEqual(["resolved", "appeared"]);
    expect(events[1]?.at.getTime()).toBeGreaterThan(events[0]?.at.getTime() ?? 0);
  });

  it("returns nothing for an empty subject list, without querying", async () => {
    expect(await listDiffEventsForSubjects(db.pool, siteId, "orphan", [])).toEqual([]);
  });
});
