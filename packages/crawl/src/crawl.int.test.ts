/**
 * The crawler against real Postgres and a local fixture server.
 *
 * The site is 403bplan.net, served from the production captures byte for byte, and the
 * expected numbers are the ones step 4 derived from those same bytes by hand: 13 pages
 * and 240 edges. Every server behaviour exercised here — the apex/www 301, the
 * `retry-after: 3600` block, the canonicalized duplicate — is one measured on this
 * estate and cited where it is used.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  countFrontier,
  createTempDatabase,
  findCrawl,
  listLinks,
  listPages,
  runMigrations,
  upsertSite,
  type SiteInput,
  type SiteRow,
  type TempDatabase,
} from "@link-graph/db";
import { crawl, PartialCrawlError, resumeCrawl, type CrawlDeps } from "./crawl.js";
import { createHostLimiter, type HostLimiter } from "./limiter.js";
import type { CrawlFetcher, FetchResult } from "./fetcher.js";
import type { CrawlSeeds } from "./seeds.js";
import {
  capture,
  HOME_URL,
  HOST,
  HTML,
  serve403bplan,
  SITEMAP_URLS,
} from "./testing/403bplan.js";
import {
  startFixtureServer,
  type FixtureHandler,
  type FixtureServer,
} from "./testing/fixture-server.js";

let db: TempDatabase;
let limiter: HostLimiter;
const servers: FixtureServer[] = [];

beforeAll(async () => {
  db = await createTempDatabase("crawl");
  await runMigrations(db.pool);
  limiter = createHostLimiter();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

afterAll(async () => {
  await limiter.stop();
  await db.drop();
});

/** A fixed clock, so nothing in a stored row depends on when the suite ran (§4.4). */
const now = () => new Date("2026-08-20T12:00:00Z");

async function serve(
  hosts: Readonly<Record<string, FixtureHandler>>,
): Promise<FixtureServer> {
  const server = await startFixtureServer(hosts);
  servers.push(server);
  return server;
}

let siteSequence = 0;

/**
 * A site row. `rateLimit` is 500 req/s rather than the production 1: the limiter is
 * covered by its own unit test, and pacing 13 pages at a second apiece would make this
 * suite take longer than its whole budget (§4.3).
 */
async function makeSite(overrides: Partial<SiteInput> = {}): Promise<SiteRow> {
  const site: SiteInput = {
    siteId: `403bplan-net-${siteSequence++}`,
    canonicalHost: HOST,
    aliases: [HOST, `www.${HOST}`],
    stageHost: null,
    enabled: true,
    truthSource: "sitemap",
    crawlerMode: "http",
    crawlScope: "full",
    sampleCeiling: null,
    rateLimit: 500,
    ignorePaths: [],
    ...overrides,
  };
  return upsertSite(db.pool, site);
}

/** The one seed given a post type of its own — see `seedsOf`. */
const PLANTED = `https://${HOST}/newsletters/`;

/**
 * Seeds from a plain URL list. Every one of these comes from `page-sitemap.xml` on the
 * real 403bplan.net, so `page` is the post type the truth source names for all 13 —
 * which is what `pages.post_type` must then hold.
 *
 * `/newsletters/` is given a different one, and it is a plant: a crawler that applied
 * one seed's post type to every row, or that re-read the seed list instead of the
 * frontier, passes a test where all 13 agree. This is the shape of a real site, where
 * `post-sitemap.xml` and `page-sitemap.xml` are two children of one index.
 */
const seedsOf = (urls: readonly string[]): CrawlSeeds => ({
  urls: urls.map((url) => ({ url, postType: url === PLANTED ? "post" : "page" })),
  truthSourceUrls: urls.length,
  truthSourceRestUrls: null,
  truthSourceSitemapUrls: urls.length,
  taxonomies: [],
});

const deps = (fetcher: CrawlFetcher): Partial<CrawlDeps> => ({ fetcher, limiter, now });

/**
 * The crawl's stored graph, with row ids replaced by the URLs they name. Two runs of the
 * same crawl assign different ids, and nothing else about them may differ — which is the
 * plan's done-criterion for this step.
 */
async function snapshot(crawlId: number): Promise<string> {
  const pages = await listPages(db.pool, crawlId);
  const links = await listLinks(db.pool, crawlId);
  const urlOf = new Map(pages.map((page) => [page.id, page.urlNormalized]));
  return JSON.stringify(
    {
      // Everything but the identity columns, so a field added to either row shows up
      // here rather than being quietly excluded from the comparison.
      pages: pages.map((page) => ({ ...page, id: undefined, crawlId: undefined })),
      links: links.map((link) => ({
        ...link,
        id: undefined,
        crawlId: undefined,
        fromPageId: urlOf.get(link.fromPageId),
        toPageId: link.toPageId === null ? null : urlOf.get(link.toPageId),
      })),
    },
    null,
    1,
  );
}

describe("crawl", () => {
  it("crawls a whole real site into pages and links", async () => {
    const server = await serve({ [HOST]: serve403bplan });
    const site = await makeSite();
    const result = await crawl(
      db.pool,
      site,
      seedsOf(SITEMAP_URLS),
      deps(server.fetcher),
    );

    expect(result.status).toBe("complete");
    // The independently derived figures: 13 sitemap pages, 240 edges (step 4).
    expect(result.pages).toBe(13);
    expect(result.links).toBe(240);
    expect(result.aliasHops).toBe(0);
    expect(result.wasThrottled).toBe(false);
    expect(result.pending).toBe(0);

    // One request per page and not one more. The 17 internal PDF links are recorded as
    // edges and never fetched (target.ts), so the crawl asks for exactly the 13 URLs.
    expect(server.requests).toHaveLength(13);
    expect(server.requests[0]).toBe(`${HOST}/`);

    const pages = await listPages(db.pool, result.crawlId);
    expect(pages.every((page) => page.statusCode === 200)).toBe(true);
    expect(pages.every((page) => page.indexable)).toBe(true);
    expect(pages.every((page) => page.inTruthSource)).toBe(true);
    // The truth source's provenance, from each seed through the frontier onto its own
    // row. It was NULL for all 2,454 pages of the integrity.com crawl, which left PRD
    // §2's Excluded classes with nothing to read (010).
    const postTypes = new Map(pages.map((page) => [page.path, page.postType]));
    expect(postTypes.get("/newsletters/")).toBe("post");
    expect(postTypes.get("/")).toBe("page");
    expect([...postTypes.values()].filter((type) => type === "page")).toHaveLength(12);
    // analyse's output, untouched by the crawler: NULL means "not analysed", and a
    // default would make an un-analysed crawl look analysed.
    expect(pages.every((page) => page.depth === null && page.class === null)).toBe(true);

    const stored = await findCrawl(db.pool, result.crawlId);
    expect(stored).toMatchObject({
      status: "complete",
      pagesSeen: 13,
      wasThrottled: false,
      truthSourceUrls: 13,
      truthSourceSitemapUrls: 13,
    });
    expect(stored?.finishedAt).toEqual(now());
  });

  it("joins internal edges to their pages and leaves the unfetched ones unresolved", async () => {
    const server = await serve({ [HOST]: serve403bplan });
    const site = await makeSite();
    const result = await crawl(
      db.pool,
      site,
      seedsOf(SITEMAP_URLS),
      deps(server.fetcher),
    );

    const links = await listLinks(db.pool, result.crawlId);
    const internal = links.filter((link) => !link.isExternal);
    const pdf = internal.filter((link) => link.toUrlNormalized.endsWith(".pdf"));
    // 17 PDF targets, never fetched, so they have no page row. `analyse` counts these
    // as internal_unresolved — "nobody checked" — and never as broken.
    expect(new Set(pdf.map((link) => link.toUrlNormalized)).size).toBe(17);
    expect(pdf.every((link) => link.toPageId === null)).toBe(true);
    // Every other internal edge points at a page of this crawl.
    const pages = internal.filter((link) => !link.toUrlNormalized.endsWith(".pdf"));
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.every((link) => link.toPageId !== null)).toBe(true);
    expect(links.every((link) => link.isBoilerplate === null)).toBe(true);
  });

  it("is byte-identical across runs", async () => {
    const first = await serve({ [HOST]: serve403bplan });
    const second = await serve({ [HOST]: serve403bplan });
    const a = await crawl(
      db.pool,
      await makeSite(),
      seedsOf(SITEMAP_URLS),
      deps(first.fetcher),
    );
    const b = await crawl(
      db.pool,
      await makeSite(),
      seedsOf(SITEMAP_URLS),
      deps(second.fetcher),
    );
    expect(await snapshot(b.crawlId)).toBe(await snapshot(a.crawlId));
    expect(second.requests).toEqual(first.requests);
  });

  it("resumes a killed crawl to the same page set, without re-fetching", async () => {
    const server = await serve({ [HOST]: serve403bplan });
    const site = await makeSite();
    // A killed worker runs no cleanup, so the crawl row is left `running` and the
    // frontier holds what it owes. This is the case a 1,953-page crawl must survive.
    const killed = killAfter(server.fetcher, 6);
    await expect(
      crawl(db.pool, site, seedsOf(SITEMAP_URLS), deps(killed)),
    ).rejects.toThrow(/worker killed/);

    const running = await db.pool.query<{ id: number; status: string }>(
      `SELECT id, status FROM crawls WHERE site_id = $1`,
      [site.id],
    );
    const crawlId = running.rows[0]?.id ?? 0;
    expect(running.rows[0]?.status).toBe("running");
    expect(await countFrontier(db.pool, crawlId)).toMatchObject({ pending: 7 });
    expect(server.requests).toHaveLength(6);

    const resumed = await resumeCrawl(db.pool, crawlId, deps(server.fetcher));
    expect(resumed).toMatchObject({ crawlId, status: "complete", pages: 13, links: 240 });
    // 6 before the kill and 7 after: the resumed run did not restart the crawl.
    expect(server.requests).toHaveLength(13);
    expect(new Set(server.requests).size).toBe(13);

    // And the page set is the one a single uninterrupted run produces.
    const reference = await serve({ [HOST]: serve403bplan });
    const whole = await crawl(
      db.pool,
      await makeSite(),
      seedsOf(SITEMAP_URLS),
      deps(reference.fetcher),
    );
    expect(await snapshot(crawlId)).toBe(await snapshot(whole.crawlId));
  });

  it("stops the host on the first 503, records it, and does not wait out the ban", async () => {
    // Measured on whyaim.com 2026-08-18: 503 with `retry-after: 3600`, a one-hour ban.
    // The crawl must not sleep through it, and must not report a short page list as a
    // finished crawl (engineering guide §1).
    const blocked = { on: true };
    const server = await serve({
      [HOST]: (path) =>
        blocked.on && path === "/disclosures/"
          ? { status: 503, headers: { "retry-after": "3600" }, body: "" }
          : serve403bplan(path),
    });
    const site = await makeSite();
    const started = Date.now();
    const error = await crawl(
      db.pool,
      site,
      seedsOf(SITEMAP_URLS),
      deps(server.fetcher),
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(PartialCrawlError);
    const result = (error as PartialCrawlError).result;
    expect(result).toMatchObject({
      status: "partial",
      wasThrottled: true,
      retryAfterSeconds: 3600,
    });
    expect(result.stoppedBecause).toMatch(/503/);
    // The whole point: an hour-long ban is not an hour of wall clock here.
    expect(Date.now() - started).toBeLessThan(5000);
    // Nothing was requested after the block. The next URL in the frontier is untouched.
    expect(server.requests.at(-1)).toBe(`${HOST}/disclosures/`);

    const stored = await findCrawl(db.pool, result.crawlId);
    expect(stored).toMatchObject({ status: "partial", wasThrottled: true });
    const frontier = await countFrontier(db.pool, result.crawlId);
    expect(frontier).toMatchObject({ total: 13, pending: 13 - result.pages, failed: 1 });
    // The blocked URL has no page row: a 503 describes our request rate, not the page,
    // and storing it as the page's status would file a live page as broken.
    const pages = await listPages(db.pool, result.crawlId);
    expect(pages.map((page) => page.path)).not.toContain("/disclosures/");

    // ... and the crawl finishes when the host recovers.
    blocked.on = false;
    const resumed = await resumeCrawl(db.pool, result.crawlId, deps(server.fetcher));
    expect(resumed).toMatchObject({ status: "complete", pages: 13, links: 240 });
    const reopened = await findCrawl(db.pool, result.crawlId);
    // The throttle happened, so it stays recorded even though the crawl completed.
    expect(reopened).toMatchObject({ status: "complete", wasThrottled: true });
  });

  it("stops when a response cannot be recorded, rather than leaving the crawl running", async () => {
    // `recordPage` refuses a response it cannot represent faithfully — here a 200
    // text/html with an empty body, which `extractPage` refuses because zero links from
    // a page that served nothing reads downstream as a page nobody links out of. The
    // refusal must not escape the loop: an escaping throw would leave the crawl row
    // `running` with nothing recorded against the URL, which is exactly what a killed
    // worker looks like.
    const server = await serve({
      [HOST]: (path) =>
        path === "/disclosures/"
          ? { status: 200, headers: HTML, body: "" }
          : serve403bplan(path),
    });
    const site = await makeSite();
    const error = await crawl(
      db.pool,
      site,
      seedsOf(SITEMAP_URLS),
      deps(server.fetcher),
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(PartialCrawlError);
    const result = (error as PartialCrawlError).result;
    expect(result.status).toBe("partial");
    expect(result.stoppedBecause).toMatch(/cannot record .*\/disclosures\/: .*empty/i);
    const stored = await findCrawl(db.pool, result.crawlId);
    expect(stored?.status).toBe("partial");
    // The URL is still owed, with the reason attached, so a resume tries it again.
    const failed = await db.pool.query<{ url_normalized: string; last_error: string }>(
      `SELECT url_normalized, last_error FROM crawl_frontier
       WHERE crawl_id = $1 AND last_error IS NOT NULL`,
      [result.crawlId],
    );
    expect(failed.rows[0]?.url_normalized).toBe(`https://${HOST}/disclosures/`);
  });

  it("stops on a transport error and keeps the URL for the resume", async () => {
    const server = await serve({ [HOST]: serve403bplan });
    const site = await makeSite();
    const dead: CrawlFetcher = {
      get: (url: string): Promise<FetchResult> =>
        url.endsWith("/contact-us/")
          ? Promise.resolve({
              kind: "transport-error",
              detail: "fetch failed: ECONNRESET",
            })
          : server.fetcher.get(url),
    };
    const error = await crawl(db.pool, site, seedsOf(SITEMAP_URLS), deps(dead)).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(PartialCrawlError);
    const result = (error as PartialCrawlError).result;
    expect(result.status).toBe("partial");
    expect(result.wasThrottled).toBe(false);
    expect(result.stoppedBecause).toMatch(/ECONNRESET/);

    const failed = await db.pool.query<{
      url_normalized: string;
      attempts: number;
      last_error: string;
    }>(
      `SELECT url_normalized, attempts, last_error FROM crawl_frontier
       WHERE crawl_id = $1 AND last_error IS NOT NULL`,
      [result.crawlId],
    );
    expect(failed.rows).toHaveLength(1);
    expect(failed.rows[0]).toMatchObject({
      url_normalized: `https://${HOST}/contact-us/`,
      attempts: 1,
    });
  });

  it("follows an apex/www alias hop inside one page fetch and counts it", async () => {
    // PRD §5.1, measured 2026-08-20: a registry canonical_host the server redirects away
    // from doubles the crawl. The redirect names the same node, so recording it would
    // store every page as a 301 to itself and never read a body.
    const server = await serve({
      [HOST]: (path) => ({
        status: 301,
        headers: { location: `https://www.${HOST}${path}` },
        body: "",
      }),
      [`www.${HOST}`]: serve403bplan,
    });
    const site = await makeSite();
    const result = await crawl(
      db.pool,
      site,
      seedsOf(SITEMAP_URLS),
      deps(server.fetcher),
    );

    expect(result).toMatchObject({
      status: "complete",
      pages: 13,
      links: 240,
      aliasHops: 13,
    });
    // Two requests per page, and the identity stored is still the registry's host.
    expect(server.requests).toHaveLength(26);
    const pages = await listPages(db.pool, result.crawlId);
    expect(pages.every((page) => page.urlNormalized.startsWith(`https://${HOST}/`))).toBe(
      true,
    );
    expect(
      pages.every((page) => page.redirectTo === null && page.statusCode === 200),
    ).toBe(true);
  });

  it("records a redirect chain hop by hop and fetches the destination", async () => {
    // WordPress 301s a changed slug and 301s again to the canonical trailing-slash form
    // (measured in step 1 on three estate sites), so a chain is the ordinary case rather
    // than an exotic one. Each hop gets its own page row: PRD §2 keeps redirects on
    // `pages.redirect_to` and never as `links` rows.
    const server = await serve({
      [HOST]: (path) => {
        if (path === "/old-newsletters/") {
          return {
            status: 301,
            headers: { location: `https://${HOST}/newsletters-2/` },
            body: "",
          };
        }
        if (path === "/newsletters-2/") {
          return { status: 302, headers: { location: "/newsletters/" }, body: "" };
        }
        return serve403bplan(path);
      },
    });
    const site = await makeSite();
    const seeds = seedsOf([HOME_URL, `https://${HOST}/old-newsletters/`]);
    const result = await crawl(db.pool, site, seeds, deps(server.fetcher));

    expect(result.status).toBe("complete");
    const byPath = new Map(
      (await listPages(db.pool, result.crawlId)).map((page) => [page.path, page]),
    );
    expect(byPath.get("/old-newsletters/")).toMatchObject({
      statusCode: 301,
      redirectTo: `https://${HOST}/newsletters-2/`,
      inTruthSource: true,
    });
    expect(byPath.get("/newsletters-2/")).toMatchObject({
      statusCode: 302,
      redirectTo: `https://${HOST}/newsletters/`,
      // Discovered by following the chain, not listed by the truth source.
      inTruthSource: false,
      // And so nothing named its post type. NULL is "unknown" — never read as content,
      // never as non-content (010).
      postType: null,
    });
    expect(byPath.get("/newsletters/")).toMatchObject({
      statusCode: 200,
      redirectTo: null,
    });
    // A redirect is never an edge.
    const links = await listLinks(db.pool, result.crawlId);
    expect(links.some((link) => link.toUrlNormalized.includes("newsletters-2"))).toBe(
      false,
    );
  });

  it("records a 404 without parsing the error page's links", async () => {
    const server = await serve({ [HOST]: serve403bplan });
    const site = await makeSite();
    const seeds = seedsOf([HOME_URL, `https://${HOST}/gone/`]);
    const result = await crawl(db.pool, site, seeds, deps(server.fetcher));

    const gone = (await listPages(db.pool, result.crawlId)).find(
      (p) => p.path === "/gone/",
    );
    expect(gone).toMatchObject({ statusCode: 404, redirectTo: null, canonicalTo: null });
    const links = await listLinks(db.pool, result.crawlId);
    expect(links.filter((link) => link.fromPageId === gone?.id)).toEqual([]);
  });

  it("records a canonical that points elsewhere and never follows it", async () => {
    // A two-node canonical *cycle* is not fixturable from this estate: step 2 probed six
    // pages and found only self-referential Yoast canonicals. What is real is the
    // canonicalized duplicate below — the same body served under a query string, with
    // its canonical naming the clean permalink — and the property that matters is the
    // same one a cycle would test: canonicals are recorded, never traversed, so no
    // arrangement of them can add a request or fail to terminate.
    const server = await serve({
      [HOST]: (path) =>
        path.startsWith("/newsletter-signup/")
          ? { status: 200, headers: HTML, body: capture("newsletter-signup.html") }
          : serve403bplan(path),
    });
    const site = await makeSite();
    const duplicate = `https://${HOST}/newsletter-signup/?ref=lgtest`;
    const seeds = seedsOf([HOME_URL, `https://${HOST}/newsletter-signup/`, duplicate]);
    const result = await crawl(db.pool, site, seeds, deps(server.fetcher));

    expect(result.status).toBe("complete");
    const canonicals = new Map(
      (await listPages(db.pool, result.crawlId)).map((page) => [
        page.urlNormalized,
        page.canonicalTo,
      ]),
    );
    expect(canonicals.get(duplicate)).toBe(`https://${HOST}/newsletter-signup/`);
    expect(canonicals.get(`https://${HOST}/newsletter-signup/`)).toBe(
      `https://${HOST}/newsletter-signup/`,
    );
    // Nothing was requested twice, and the canonical target was requested once — as a
    // seed, not because two pages named it. A canonical is a recorded fact here, never
    // an edge to traverse, which is why no arrangement of them can add a request or
    // fail to terminate.
    expect(new Set(server.requests).size).toBe(server.requests.length);
    expect(
      server.requests.filter((r) => r === `${HOST}/newsletter-signup/`),
    ).toHaveLength(1);
  });

  it("stops a sampled crawl at its ceiling and calls that complete", async () => {
    // PRD §15: agent.familyfirstlife.com is 59,363 templated pages, so a sample is the
    // policy rather than a shortfall. The crawl is complete; the orphan count is what
    // goes unknown, and `analyse` says so with a reason.
    const server = await serve({ [HOST]: serve403bplan });
    const site = await makeSite({ crawlScope: "sample", sampleCeiling: 5 });
    const result = await crawl(
      db.pool,
      site,
      seedsOf(SITEMAP_URLS),
      deps(server.fetcher),
    );

    expect(result).toMatchObject({ status: "complete", pages: 5, pending: 8 });
    expect(server.requests).toHaveLength(5);
    const stored = await findCrawl(db.pool, result.crawlId);
    expect(stored).toMatchObject({ status: "complete", pagesSeen: 5 });
  });

  it("refuses a sample ceiling that is not smaller than the inventory", async () => {
    const server = await serve({ [HOST]: serve403bplan });
    const site = await makeSite({ crawlScope: "sample", sampleCeiling: 13 });
    await expect(
      crawl(db.pool, site, seedsOf(SITEMAP_URLS), deps(server.fetcher)),
    ).rejects.toThrow(/sample_ceiling/);
    // Nothing was requested and no crawl row was written.
    expect(server.requests).toEqual([]);
    const crawls = await db.pool.query(`SELECT id FROM crawls WHERE site_id = $1`, [
      site.id,
    ]);
    expect(crawls.rows).toEqual([]);
  });

  it("refuses to crawl a site with an inventory and no seeds", async () => {
    const server = await serve({ [HOST]: serve403bplan });
    const site = await makeSite();
    await expect(crawl(db.pool, site, seedsOf([]), deps(server.fetcher))).rejects.toThrow(
      /no seed URLs/,
    );
    expect(server.requests).toEqual([]);
  });

  it("crawls a site with no truth source from its homepage, and marks nothing in it", async () => {
    // PRD §4: such a site is still crawlable for structure. It must never report zero
    // orphans, which is `analyse`'s job — the crawler's job is not to claim its pages
    // are in an inventory that does not exist.
    const server = await serve({ [HOST]: serve403bplan });
    const site = await makeSite({ truthSource: "none" });
    const result = await crawl(
      db.pool,
      site,
      {
        urls: [],
        truthSourceUrls: null,
        truthSourceRestUrls: null,
        truthSourceSitemapUrls: null,
        taxonomies: [],
      },
      deps(server.fetcher),
    );

    // Nine of the 13 pages are reachable from the homepage; the other four are the true
    // orphans step 4 found, and nothing links to them.
    expect(result.status).toBe("complete");
    expect(result.pages).toBe(9);
    const pages = await listPages(db.pool, result.crawlId);
    expect(pages.every((page) => !page.inTruthSource)).toBe(true);
    expect(await findCrawl(db.pool, result.crawlId)).toMatchObject({
      truthSourceUrls: null,
    });
  });

  /**
   * **The one line that decides whether step 7's 480 false orphans come back, and the
   * only test that runs it.** Every other case here injects a fetcher — it has to, since
   * the fixture server cannot answer at the site's canonical host — so `FETCHERS[mode]()`
   * in `resolveDeps` is otherwise never executed, and `crawl()` passing a hardcoded
   * `"http"` instead of `site.crawlerMode` would leave this suite green.
   *
   * The host is `.invalid`, which RFC 2606 reserves and no resolver ever answers, so this
   * reaches no network. What it asserts is *which* client failed to resolve it.
   *
   * **Both report `ENOTFOUND`, and that is itself worth knowing**: the browser fetcher
   * takes the main document through `route.fetch()`, which is Playwright's Node-side
   * request context, so the document's DNS happens where undici's does and not in
   * Chromium's network stack. The fingerprint is what rides along — Playwright appends a
   * `Call log:` with the browser's own request headers, `sec-ch-ua: "HeadlessChrome"`
   * among them, which the undici path has no way to produce.
   */
  describe("crawler_mode chooses the fetcher, with nothing injected", () => {
    const unresolvable = "crawl-mode-probe.invalid";
    const runWithMode = async (crawlerMode: "http" | "playwright") => {
      const site = await makeSite({
        crawlerMode,
        canonicalHost: unresolvable,
        aliases: [unresolvable],
      });
      const home = `https://${unresolvable}/`;
      // No `fetcher` in deps: the limiter and clock only, so the crawler builds its own.
      const error = await crawl(db.pool, site, seedsOf([home]), { limiter, now }).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(PartialCrawlError);
      return (error as PartialCrawlError).result.stoppedBecause ?? "";
    };

    it("uses Chromium for a playwright site", async () => {
      const reason = await runWithMode("playwright");
      expect(reason).toMatch(/HeadlessChrome/);
      expect(reason).toMatch(/Call log:/);
    });

    it("uses undici for an http site", async () => {
      const reason = await runWithMode("http");
      expect(reason).toMatch(/ENOTFOUND|EAI_AGAIN/);
      expect(reason).not.toMatch(/HeadlessChrome/);
      expect(reason).not.toMatch(/Call log:/);
    });
  });

  it("refuses to resume a crawl that already completed", async () => {
    const server = await serve({ [HOST]: serve403bplan });
    const site = await makeSite();
    const result = await crawl(
      db.pool,
      site,
      seedsOf(SITEMAP_URLS),
      deps(server.fetcher),
    );
    await expect(
      resumeCrawl(db.pool, result.crawlId, deps(server.fetcher)),
    ).rejects.toThrow(/complete/);
  });
});

/**
 * A fetcher that stops working partway, the way a killed worker does: no cleanup, no
 * chance to close the crawl row.
 */
function killAfter(inner: CrawlFetcher, requests: number): CrawlFetcher {
  let seen = 0;
  return {
    get(url: string): Promise<FetchResult> {
      if (seen++ >= requests) throw new Error("worker killed");
      return inner.get(url);
    },
  };
}
