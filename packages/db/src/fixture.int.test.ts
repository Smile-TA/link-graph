/**
 * `loadFixture` against real Postgres: what actually lands in the tables.
 *
 * The capture-backed test is the important one. It builds a crawl out of
 * `extractPage`'s output over the six checked-in production captures and then reads
 * the rows back, which is the only way to know the JSON contract can carry real
 * crawler output rather than the shape of a hand-written example.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixture, loadFixtureFile, parseCrawlFixture } from "./fixture.js";
import { runMigrations } from "./migrate.js";
import { findCrawl } from "./repo/crawls.js";
import { listLinks } from "./repo/links.js";
import { listPages } from "./repo/pages.js";
import { findSiteBySlug } from "./repo/sites.js";
import { CAPTURE_SITES, captureCrawlJson, expectedLinks } from "./testing/captures.js";
import { createTempDatabase, type TempDatabase } from "./testing/temp-database.js";

/**
 * Three links from one real page: one to a page in this crawl, one to a page on the
 * same site the crawl never fetched, one external. Those are the three cases
 * `to_page_id` has to distinguish.
 */
interface LinkJson {
  from: string;
  to: string;
  anchor: string;
  container: string;
  rel?: string;
  domIndex?: number;
}

interface CrawlJson {
  site: Record<string, unknown>;
  crawl: Record<string, unknown>;
  pages: Record<string, unknown>[];
  links: LinkJson[];
}

const lionstreet = (): CrawlJson => ({
  site: {
    siteId: "lionstreet-com",
    canonicalHost: "lionstreet.com",
    aliases: ["lionstreet.com", "www.lionstreet.com"],
    truthSource: "sitemap",
  },
  crawl: {
    status: "complete",
    startedAt: "2026-08-20T09:00:00.000Z",
    finishedAt: "2026-08-20T09:01:00.000Z",
    deployedTag: "v1.7.0",
  },
  pages: [
    {
      url: "https://lionstreet.com/",
      statusCode: 200,
      inTruthSource: true,
      indexable: true,
    },
    {
      url: "https://lionstreet.com/testimonials/",
      statusCode: 200,
      inTruthSource: true,
      indexable: true,
    },
  ],
  links: [
    {
      from: "https://lionstreet.com/",
      to: "https://lionstreet.com/testimonials/",
      anchor: "Testimonials",
      container: "header",
    },
    {
      from: "https://lionstreet.com/",
      to: "https://lionstreet.com/terms-and-conditions/",
      anchor: "Terms & Conditions",
      container: "footer",
      rel: "nofollow",
    },
    {
      from: "https://lionstreet.com/",
      to: "https://www.linkedin.com/company/lion-street/",
      anchor: "",
      container: "footer",
    },
  ],
});

let db: TempDatabase;
beforeAll(async () => {
  db = await createTempDatabase("fixture");
  await runMigrations(db.pool);
});
afterAll(async () => {
  await db.drop();
});

describe("loadFixture", () => {
  it("writes the site, the crawl, its pages and its links", async () => {
    const loaded = await loadFixture(db.pool, parseCrawlFixture(lionstreet()));
    expect(loaded.pages).toBe(2);
    expect(loaded.links).toBe(3);

    const crawl = await findCrawl(db.pool, loaded.crawlId);
    expect(crawl).toMatchObject({
      siteId: loaded.siteId,
      env: "prod",
      status: "complete",
      deployedTag: "v1.7.0",
      // pages_seen is derived from the fixture's page count, not accepted as a field.
      pagesSeen: 2,
      wasThrottled: false,
    });
    expect(crawl?.startedAt).toEqual(new Date("2026-08-20T09:00:00.000Z"));

    const site = await findSiteBySlug(db.pool, "lionstreet-com");
    expect(site).toMatchObject({
      canonicalHost: "lionstreet.com",
      aliases: ["lionstreet.com", "www.lionstreet.com"],
      truthSource: "sitemap",
      crawlerMode: "http",
      rateLimit: 1,
      enabled: true,
      ignorePaths: [],
    });
  });

  it("resolves to_page_id only to pages in the same crawl", async () => {
    const loaded = await loadFixture(db.pool, parseCrawlFixture(lionstreet()));
    const pages = await listPages(db.pool, loaded.crawlId);
    const links = await listLinks(db.pool, loaded.crawlId);
    const testimonials = pages.find(
      (p) => p.urlNormalized === "https://lionstreet.com/testimonials/",
    );

    expect(
      links.map((l) => [l.toUrlNormalized, l.toPageId, l.isExternal, l.domIndex]),
    ).toEqual([
      // crawled: resolves to a row in this crawl
      ["https://lionstreet.com/testimonials/", testimonials?.id, false, 0],
      // internal but never fetched: a URL with no page id, which is what a link to
      // an uncrawled page means
      ["https://lionstreet.com/terms-and-conditions/", null, false, 1],
      // external: no page id by definition
      ["https://www.linkedin.com/company/lion-street/", null, true, 2],
    ]);
    expect(links.map((l) => [l.anchor, l.rel, l.container])).toEqual([
      ["Testimonials", null, "header"],
      ["Terms & Conditions", "nofollow", "footer"],
      ["", null, "footer"],
    ]);
  });

  it("leaves analyse's columns null, so an unanalysed crawl cannot look analysed", async () => {
    const loaded = await loadFixture(db.pool, parseCrawlFixture(lionstreet()));
    const pages = await listPages(db.pool, loaded.crawlId);
    const links = await listLinks(db.pool, loaded.crawlId);
    expect(pages.map((p) => [p.depth, p.class])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(links.map((l) => l.isBoilerplate)).toEqual([null, null, null]);
  });

  it("derives path from the URL", async () => {
    const loaded = await loadFixture(db.pool, parseCrawlFixture(lionstreet()));
    const pages = await listPages(db.pool, loaded.crawlId);
    expect(pages.map((p) => p.path)).toEqual(["/", "/testimonials/"]);
  });

  it("takes the crawl's start time from the injected clock when the fixture omits it", async () => {
    const frozen = new Date("2026-01-02T03:04:05.000Z");
    const json = lionstreet();
    delete json.crawl.startedAt;
    const loaded = await loadFixture(db.pool, parseCrawlFixture(json), {
      now: () => frozen,
    });
    expect((await findCrawl(db.pool, loaded.crawlId))?.startedAt).toEqual(frozen);
  });

  it("loads the same site twice as two crawls against one site row", async () => {
    const first = await loadFixture(db.pool, parseCrawlFixture(lionstreet()));
    const second = await loadFixture(db.pool, parseCrawlFixture(lionstreet()));
    expect(second.crawlId).not.toBe(first.crawlId);
    expect(second.siteId).toBe(first.siteId);
    const { rows } = await db.pool.query<{ n: number }>(
      `SELECT count(*) AS n FROM sites WHERE site_id = 'lionstreet-com'`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("writes all of a fixture or none of it", async () => {
    const before = await db.pool.query<{ n: number }>(`SELECT count(*) AS n FROM crawls`);
    const json = lionstreet();
    // Two links from one page claiming the same DOM position: the unique constraint
    // rejects it. The whole load must roll back rather than land a crawl with a
    // partial link set, which would read downstream as a smaller page.
    json.links[0] = { ...json.links[0]!, domIndex: 7 };
    json.links[1] = { ...json.links[1]!, domIndex: 7 };
    await expect(loadFixture(db.pool, parseCrawlFixture(json))).rejects.toThrow(
      /duplicate key value|links_crawl_id_from_page_id_dom_index_key/,
    );
    const after = await db.pool.query<{ n: number }>(`SELECT count(*) AS n FROM crawls`);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});

describe("loadFixture: every column, at a non-default value", () => {
  /**
   * Each column below is set to something the schema would NOT have supplied on its
   * own. Mutation testing found that asserting `env: "prod"`, `rateLimit: 1`,
   * `crawlerMode: "http"`, `wasThrottled: false` and `enabled: true` proves nothing:
   * dropping those columns from the INSERT entirely leaves the suite green, because
   * they are the SQL DEFAULTs. The same applied to every column only ever asserted
   * null — `depth`, `class`, `is_boilerplate`, `post_type`, `redirect_to` — which is
   * also the capability step 4 and step 11 need: seeding an already-analysed crawl.
   */
  const everything = () => ({
    site: {
      siteId: "tidewatermg-com",
      canonicalHost: "tidewatermg.com",
      aliases: ["tidewatermg.com", "www.tidewatermg.com"],
      stageHost: "aging02.imgwebhost.com",
      enabled: false,
      truthSource: "rest",
      crawlerMode: "playwright",
      rateLimit: 0.5,
      ignorePaths: ["/wp-login.php", "/carrier-index/"],
    },
    crawl: {
      env: "stage",
      status: "partial",
      startedAt: "2026-08-20T09:00:00.000Z",
      finishedAt: "2026-08-20T09:30:00.000Z",
      deployedTag: "v1.7.0",
      registrySha: "0d1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b",
      // How large the truth source was (step 5). The three counts here are the shape
      // measured on integrity.com's `page` post type — REST 124, sitemap 96, union 124
      // — which is the case that only exists because the two sources disagree.
      truthSourceUrls: 124,
      truthSourceRestUrls: 124,
      truthSourceSitemapUrls: 96,
      wasThrottled: true,
    },
    pages: [
      {
        url: "https://tidewatermg.com/",
        postType: "page",
        statusCode: 200,
        depth: 0,
        inTruthSource: true,
        indexable: true,
        canonicalTo: "https://tidewatermg.com/",
        class: "linked",
      },
      {
        url: "https://tidewatermg.com/?s=medicare",
        postType: "search",
        statusCode: 301,
        depth: 2,
        inTruthSource: false,
        indexable: false,
        redirectTo: "https://tidewatermg.com/",
        class: "excluded",
      },
    ],
    links: [
      {
        from: "https://tidewatermg.com/",
        to: "https://tidewatermg.com/?s=medicare",
        anchor: "Search",
        rel: "nofollow noopener",
        container: "aside",
        domIndex: 11,
        isBoilerplate: true,
      },
    ],
  });

  it("round-trips the site row", async () => {
    const loaded = await loadFixture(db.pool, parseCrawlFixture(everything()));
    expect(await findSiteBySlug(db.pool, "tidewatermg-com")).toEqual({
      id: loaded.siteId,
      siteId: "tidewatermg-com",
      canonicalHost: "tidewatermg.com",
      aliases: ["tidewatermg.com", "www.tidewatermg.com"],
      stageHost: "aging02.imgwebhost.com",
      enabled: false,
      truthSource: "rest",
      crawlerMode: "playwright",
      rateLimit: 0.5,
      ignorePaths: ["/wp-login.php", "/carrier-index/"],
    });
  });

  it("round-trips the crawl row, partial status and all", async () => {
    const loaded = await loadFixture(db.pool, parseCrawlFixture(everything()));
    expect(await findCrawl(db.pool, loaded.crawlId)).toEqual({
      id: loaded.crawlId,
      siteId: loaded.siteId,
      env: "stage",
      startedAt: new Date("2026-08-20T09:00:00.000Z"),
      finishedAt: new Date("2026-08-20T09:30:00.000Z"),
      status: "partial",
      deployedTag: "v1.7.0",
      registrySha: "0d1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b",
      pagesSeen: 2,
      wasThrottled: true,
      truthSourceUrls: 124,
      truthSourceRestUrls: 124,
      truthSourceSitemapUrls: 96,
    });
  });

  it("round-trips every page column, including the ones analyse writes", async () => {
    const loaded = await loadFixture(db.pool, parseCrawlFixture(everything()));
    const pages = await listPages(db.pool, loaded.crawlId);
    expect(pages).toEqual([
      {
        id: pages[0]?.id,
        crawlId: loaded.crawlId,
        urlNormalized: "https://tidewatermg.com/",
        path: "/",
        postType: "page",
        statusCode: 200,
        depth: 0,
        inTruthSource: true,
        indexable: true,
        canonicalTo: "https://tidewatermg.com/",
        redirectTo: null,
        class: "linked",
      },
      {
        id: pages[1]?.id,
        crawlId: loaded.crawlId,
        urlNormalized: "https://tidewatermg.com/?s=medicare",
        path: "/?s=medicare",
        postType: "search",
        statusCode: 301,
        depth: 2,
        inTruthSource: false,
        indexable: false,
        canonicalTo: null,
        redirectTo: "https://tidewatermg.com/",
        class: "excluded",
      },
    ]);
  });

  it("round-trips every link column", async () => {
    const loaded = await loadFixture(db.pool, parseCrawlFixture(everything()));
    const pages = await listPages(db.pool, loaded.crawlId);
    const links = await listLinks(db.pool, loaded.crawlId);
    expect(links).toEqual([
      {
        id: links[0]?.id,
        crawlId: loaded.crawlId,
        fromPageId: pages.find((p) => p.path === "/")?.id,
        toUrlNormalized: "https://tidewatermg.com/?s=medicare",
        toPageId: pages.find((p) => p.path === "/?s=medicare")?.id,
        anchor: "Search",
        rel: "nofollow noopener",
        isExternal: false,
        isBoilerplate: true,
        container: "aside",
        domIndex: 11,
      },
    ]);
  });
});

describe("loadFixtureFile", () => {
  it("loads a JSON crawl from disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "link-graph-fixture-"));
    const file = path.join(dir, "lionstreet.crawl.json");
    await writeFile(file, JSON.stringify(lionstreet(), null, 2), "utf8");
    const loaded = await loadFixtureFile(db.pool, file);
    expect([loaded.pages, loaded.links]).toEqual([2, 3]);
  });

  it("names the file and the field when the JSON does not describe a crawl", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "link-graph-fixture-"));
    const file = path.join(dir, "broken.crawl.json");
    const json = lionstreet();
    delete json.pages[0]!.indexable;
    await writeFile(file, JSON.stringify(json), "utf8");
    await expect(loadFixtureFile(db.pool, file)).rejects.toThrow(
      /broken\.crawl\.json: fixture pages\[0\]: indexable is required/,
    );
  });

  it("reports a file that is not JSON at all", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "link-graph-fixture-"));
    const file = path.join(dir, "truncated.crawl.json");
    await writeFile(file, '{"site":', "utf8");
    await expect(loadFixtureFile(db.pool, file)).rejects.toThrow(
      /truncated\.crawl\.json/,
    );
  });
});

describe("loadFixture: the six production captures", () => {
  it("loads every capture site, and the rows in the tables match the extraction", async () => {
    for (const site of CAPTURE_SITES) {
      const loaded = await loadFixture(
        db.pool,
        parseCrawlFixture(captureCrawlJson(site)),
      );
      expect([loaded.pages, loaded.links], site.siteId).toEqual([
        site.captures.length,
        expectedLinks(site),
      ]);
      const pages = await listPages(db.pool, loaded.crawlId);
      const links = await listLinks(db.pool, loaded.crawlId);
      expect(pages).toHaveLength(loaded.pages);
      expect(links).toHaveLength(loaded.links);
      // Every internal target that names a page in this crawl must have resolved.
      const byUrl = new Map(pages.map((p) => [p.urlNormalized, p.id]));
      for (const link of links) {
        expect(link.toPageId).toBe(byUrl.get(link.toUrlNormalized) ?? null);
      }
    }
  });

  it("keeps the noindex capture unindexable and its canonical", async () => {
    const tidewater = CAPTURE_SITES.find((s) => s.siteId === "tidewatermg-com")!;
    const loaded = await loadFixture(
      db.pool,
      parseCrawlFixture(captureCrawlJson(tidewater)),
    );
    const pages = await listPages(db.pool, loaded.crawlId);
    expect(
      pages.map((p) => [p.path, p.indexable, p.inTruthSource, p.canonicalTo]),
    ).toEqual([
      ["/", true, true, "https://tidewatermg.com/"],
      ["/?s=medicare", false, false, null],
    ]);
  });
});
