/**
 * Fixture JSON built from the page captures checked into `packages/core`.
 *
 * Those captures are unmodified production responses (PRD §5.1, 1 req/s), and they
 * are the only real crawl output that exists before step 6. Reading them here keeps
 * the fixture contract honest: if the JSON shape ever stops being able to carry what
 * `extractPage` returns, these break.
 *
 * Two fields cannot come from the HTML and are stipulated, marked below:
 * `inTruthSource` belongs to step 5, and a status code belongs to step 6. Everything
 * else — links, anchors, containers, DOM order, `indexable`, `canonicalTo` — is
 * measured from the capture.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractPage, type SiteHosts } from "@link-graph/core";

export interface Capture {
  readonly file: string;
  /** The URL the response was fetched from. */
  readonly url: string;
  /** Stipulated: no truth source has been resolved for these sites yet (step 5). */
  readonly inTruthSource: boolean;
  /**
   * Links `extractPage` finds in this capture. The same figures core's
   * `extract.test.ts` derives from the raw markup — 539 over the six captures — kept
   * here so both test tiers assert one number rather than two tables of their own.
   */
  readonly links: number;
}

export interface CaptureSite {
  readonly siteId: string;
  readonly canonicalHost: string;
  /**
   * URLs in the site's sitemap — how large the truth source is, against the one or two
   * pages of it these captures hold.
   *
   * This is the number that turns each of these fixtures from "a clean little site with
   * no orphans" into what it actually is: a token sample. `analyse` refuses a crawl
   * covering materially less of its truth source than it should (step 5), and
   * `analyse.int.test.ts` asserts that refusal against the integrity.com capture — one
   * page of 1,953.
   *
   * 403bplan.net (13) and lionstreet.com (55) are from `census.json`; tidewatermg.com
   * (989) likewise, though its index was measured 2026-08-20 to have 34 children where
   * the census records 33. integrity.com's 1,953 is PRD §1/§4's figure and was not
   * re-counted: its index has 14 children, of which only `page-sitemap.xml` (96 URLs)
   * was fetched.
   */
  readonly sitemapUrls: number;
  readonly captures: readonly Capture[];
}

export const CAPTURE_SITES: readonly CaptureSite[] = [
  {
    siteId: "403bplan-net",
    sitemapUrls: 13,
    canonicalHost: "403bplan.net",
    captures: [
      {
        file: "403bplan-home.html",
        url: "https://403bplan.net/",
        inTruthSource: true,
        links: 17,
      },
      {
        file: "403bplan-newsletter-canonicalized.html",
        // Fetched with a query string on purpose, so its canonical points elsewhere.
        // A truth source lists the canonical form, never this one — hence false.
        url: "https://403bplan.net/newsletter-signup/?ref=lgtest",
        inTruthSource: false,
        links: 14,
      },
    ],
  },
  {
    siteId: "integrity-com",
    sitemapUrls: 1953,
    canonicalHost: "integrity.com",
    captures: [
      {
        file: "integrity-home.html",
        url: "https://integrity.com/",
        inTruthSource: true,
        links: 58,
      },
    ],
  },
  {
    siteId: "lionstreet-com",
    sitemapUrls: 55,
    canonicalHost: "lionstreet.com",
    captures: [
      {
        file: "lionstreet-home.html",
        url: "https://lionstreet.com/",
        inTruthSource: true,
        links: 25,
      },
    ],
  },
  {
    siteId: "tidewatermg-com",
    sitemapUrls: 989,
    canonicalHost: "tidewatermg.com",
    captures: [
      {
        file: "tidewater-home.html",
        url: "https://tidewatermg.com/",
        inTruthSource: true,
        links: 346,
      },
      {
        // A search results page: never in a sitemap, and noindex in the capture.
        file: "tidewater-search-noindex.html",
        url: "https://tidewatermg.com/?s=medicare",
        inTruthSource: false,
        links: 79,
      },
    ],
  },
];

function siteHosts(canonicalHost: string): SiteHosts {
  return { canonicalHost, aliases: [canonicalHost, `www.${canonicalHost}`] };
}

/** Total links a site's captures hold — the figure both test tiers assert. */
export function expectedLinks(site: CaptureSite): number {
  return site.captures.reduce((total, capture) => total + capture.links, 0);
}

/**
 * The captures total ~1.15 MB of HTML and both test tiers build fixtures from them
 * repeatedly; parsing tidewater's 612 KB five times is the bulk of the unit tier's
 * runtime. `captureCrawlJson` is pure, so its result is cached.
 */
const cache = new Map<string, unknown>();

function captureHtml(file: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../core/test/fixtures/pages/${file}`, import.meta.url)),
    "utf8",
  );
}

/**
 * One site's captures as fixture JSON — deliberately `unknown`, so callers go through
 * `parseCrawlFixture` and exercise the contract rather than bypassing it.
 */
export function captureCrawlJson(site: CaptureSite): unknown {
  const cached = cache.get(site.siteId);
  if (cached !== undefined) return cached;
  const hosts = siteHosts(site.canonicalHost);
  const pages = [];
  const links = [];
  for (const capture of site.captures) {
    const extracted = extractPage(captureHtml(capture.file), capture.url, hosts);
    pages.push({
      url: capture.url,
      // Stipulated: these responses were saved without their status line, and a
      // capture that parses was a 200 when it was taken.
      statusCode: 200,
      inTruthSource: capture.inTruthSource,
      indexable: !extracted.head.noindex,
      canonicalTo: extracted.head.canonical?.href ?? null,
    });
    for (const link of extracted.links) {
      links.push({
        from: capture.url,
        to: link.target.href,
        anchor: link.anchor,
        rel: link.rel,
        container: link.container,
        domIndex: link.domIndex,
      });
    }
  }
  const json = {
    site: {
      siteId: site.siteId,
      canonicalHost: site.canonicalHost,
      aliases: hosts.aliases,
      truthSource: "sitemap",
    },
    crawl: {
      status: "complete",
      startedAt: "2026-08-20T00:00:00.000Z",
      finishedAt: "2026-08-20T00:05:00.000Z",
      truthSourceUrls: site.sitemapUrls,
      truthSourceSitemapUrls: site.sitemapUrls,
    },
    pages,
    links,
  };
  cache.set(site.siteId, json);
  return json;
}
