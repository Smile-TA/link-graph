/**
 * The step-4 fixture: one crawl of **403bplan.net**, transcribed from checked-in
 * production responses rather than invented.
 *
 * **Provenance.** `sitemap_index.xml` → `page-sitemap.xml` → 13 `<loc>` URLs, then each
 * page, then `/?s=403b`. Captured 2026-08-20 at 1 req/s sequentially (PRD §5.1); 16
 * requests, all HTTP 200. The bodies are in
 * `packages/analyse/test/fixtures/403bplan-net/`, byte-for-byte as served; the sitemap
 * XML is not committed, so what a reader can check here is `docs/census.json`, which
 * independently records `{"host": "403bplan.net", "urls": 13, "via":
 * "sitemap_index.xml"}` — the 13 URLs are the whole site. `home.html` and
 * `newsletter-signup.html` are byte-identical (sha1 `1587f661…`, `b3d4648a…`) to step
 * 2's two 403bplan captures in `packages/core`, which is a useful cross-check and also
 * 97 KB of duplication nobody has yet had a reason to remove.
 *
 * **This deliberately duplicates `@link-graph/db`'s `testing/captures.ts`**, which does
 * the same capture → fixture-JSON job for the six step-3 captures. The two differ in what
 * they stipulate (that one declares `inTruthSource` and an expected link count per
 * capture; this one derives `inTruthSource` from the sitemap and returns a typed object
 * so a test can plant an anomaly by editing one edge) and consolidating them means
 * reworking step 3's helper, which is out of scope here. Recorded so that the next step
 * that needs a site fixture merges them rather than adding a third.
 *
 * **Why a whole small site rather than a hand-typed sample.** The plan's done-criterion
 * for step 4 is a fixture whose answer is known independently of the code. Transcribing
 * every page of a real 13-page site gives an answer that can be checked by hand edge by
 * edge, and hand-typing 240 links would only add transcription errors. Nothing here is
 * fabricated: `extractPage` reads the links out of the real markup, and the two facts
 * the markup cannot carry are stipulated and marked below.
 *
 * **The anomalies, and how each one got there.** These are what step 4 has to classify,
 * and every one of them is verified by hand in `analyse.int.test.ts`:
 *
 * | anomaly                                | how                                                     |
 * | -------------------------------------- | ------------------------------------------------------- |
 * | 4 true orphans                         | real: nothing on the site links to them                 |
 * | 3 soft orphans                         | real: linked from the nav or the footer and nowhere else |
 * | 1 `noindex` page                       | **planted**: `includeSearchPage`, see below              |
 * | 17 internal edges with no page row     | real: PDFs under `/wp-content/uploads/`, never fetched   |
 *
 * The four orphans are `/test-pay-button/`, `/newsletter-signup/`, `/newsletters/` and
 * `/plan-participant/online-access/`. All four are in the sitemap, all four returned
 * 200, and no `<a href>` anywhere on the site points at them. `/newsletter-signup/` is
 * the one step 2 found: the site's only link to it is `<!--<a
 * href="/newsletter-signup" …>-->`, commented out in the footer of every page.
 *
 * **The planted `noindex` page.** 403bplan.net has no page a crawl of it could reach
 * that carries `noindex` — measured: all 13 sitemap pages are indexable, the site has
 * no search form, and no `<a href>` on it points at a `?s=` URL. So `/?s=403b` is
 * fetched and added deliberately, with `includeSearchPage`. Its `noindex, follow` is
 * real, served by Yoast. Two consequences are predicted rather than discovered, and
 * asserted separately, which is the point of planting it:
 *
 * 1. it classifies as `excluded`, not as an orphan, though nothing links to it;
 * 2. it is the site's only link to `/plan-participant/online-access/` ("Online
 *    Access", in `main`), so adding it takes that page **out** of the orphan set. A
 *    `noindex` search-results page hides a real orphan — see the note in
 *    `analyse.int.test.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractPage, type ExtractedPage, type SiteHosts } from "@link-graph/core";

const SITE_ID = "403bplan-net";
const CANONICAL_HOST = "403bplan.net";
export const HOME_URL = "https://403bplan.net/";
/** The planted `noindex` page. Not in the sitemap, and nothing on the site links to it. */
export const SEARCH_URL = "https://403bplan.net/?s=403b";

const SITE_HOSTS: SiteHosts = {
  canonicalHost: CANONICAL_HOST,
  aliases: [CANONICAL_HOST, `www.${CANONICAL_HOST}`],
};

interface Capture {
  readonly url: string;
  readonly file: string;
}

/**
 * The 13 `<loc>` entries of `https://403bplan.net/page-sitemap.xml` in sitemap order,
 * each paired with its capture. `__` in a filename is the `/` of a nested permalink.
 */
const SITEMAP_CAPTURES: readonly Capture[] = [
  { url: HOME_URL, file: "home.html" },
  { url: "https://403bplan.net/test-pay-button/", file: "test-pay-button.html" },
  { url: "https://403bplan.net/contact-us/", file: "contact-us.html" },
  { url: "https://403bplan.net/disclosures/", file: "disclosures.html" },
  { url: "https://403bplan.net/newsletter-signup/", file: "newsletter-signup.html" },
  { url: "https://403bplan.net/newsletters/", file: "newsletters.html" },
  {
    url: "https://403bplan.net/plan-participant/financial-calculators/",
    file: "plan-participant__financial-calculators.html",
  },
  {
    url: "https://403bplan.net/plan-participant/online-access/",
    file: "plan-participant__online-access.html",
  },
  { url: "https://403bplan.net/terms-of-service/", file: "terms-of-service.html" },
  { url: "https://403bplan.net/plan-participant/", file: "plan-participant.html" },
  { url: "https://403bplan.net/plan-sponsor/", file: "plan-sponsor.html" },
  { url: "https://403bplan.net/financial-advisor/", file: "financial-advisor.html" },
  {
    url: "https://403bplan.net/plan-participant/fund-prospectuses/",
    file: "plan-participant__fund-prospectuses.html",
  },
];

const SEARCH_CAPTURE: Capture = { url: SEARCH_URL, file: "search-403b.html" };

export interface FixturePageJson {
  readonly url: string;
  /** `null` means the crawl never fetched it — a case the refusal tests need. */
  readonly statusCode: number | null;
  readonly inTruthSource: boolean;
  readonly indexable: boolean;
  readonly canonicalTo: string | null;
}

export interface FixtureLinkJson {
  readonly from: string;
  readonly to: string;
  readonly anchor: string;
  readonly rel: string | null;
  readonly container: string;
  readonly domIndex: number;
}

/**
 * Deliberately shaped like the JSON `parseCrawlFixture` reads, and deliberately
 * mutable-friendly: a test that plants an anomaly does it by editing this — dropping
 * one named edge — and then hands the result to `parseCrawlFixture`, so the plant goes
 * through the same validation as everything else.
 */
export interface FixtureCrawlJson {
  readonly site: Record<string, unknown>;
  readonly crawl: Record<string, unknown>;
  readonly pages: FixturePageJson[];
  readonly links: FixtureLinkJson[];
}

/**
 * Each capture parsed once, however many crawls a test file builds. What is retained is
 * `extractPage`'s output — ~240 links and 14 head records, tens of KB — not the 700 KB
 * of markup, which is garbage as soon as `extractPage` returns. The saving is the
 * cheerio parse: `analyse.int.test.ts` builds a crawl a dozen times.
 */
const parsed = new Map<string, ExtractedPage>();

function extract(capture: Capture): ExtractedPage {
  const cached = parsed.get(capture.file);
  if (cached !== undefined) return cached;
  const html = readFileSync(
    fileURLToPath(
      new URL(`../../test/fixtures/403bplan-net/${capture.file}`, import.meta.url),
    ),
    "utf8",
  );
  const extracted = extractPage(html, capture.url, SITE_HOSTS);
  parsed.set(capture.file, extracted);
  return extracted;
}

export interface Build403bplanOptions {
  /**
   * Add the planted `noindex` `/?s=403b` page. Default `false`, so the default crawl
   * is the site exactly as its own pages describe it.
   */
  readonly includeSearchPage?: boolean;
}

export function build403bplanCrawl(options: Build403bplanOptions = {}): FixtureCrawlJson {
  const captures =
    options.includeSearchPage === true
      ? [...SITEMAP_CAPTURES, SEARCH_CAPTURE]
      : SITEMAP_CAPTURES;
  const pages: FixturePageJson[] = [];
  const links: FixtureLinkJson[] = [];
  for (const capture of captures) {
    const { links: extracted, head } = extract(capture);
    pages.push({
      url: capture.url,
      // Stipulated: curl recorded 200 for all 16 requests, but the saved bodies do not
      // carry their status line.
      statusCode: 200,
      // Stipulated: the truth source belongs to step 5. This is the sitemap, read once
      // at capture time — the only URL not in it is the planted search page.
      inTruthSource: capture.url !== SEARCH_URL,
      indexable: !head.noindex,
      canonicalTo: head.canonical?.href ?? null,
    });
    for (const link of extracted) {
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
  return {
    site: {
      siteId: SITE_ID,
      canonicalHost: CANONICAL_HOST,
      aliases: SITE_HOSTS.aliases,
      // Measured: census.json records `via: sitemap_index.xml` for this host, and the
      // capture followed exactly that path.
      truthSource: "sitemap",
    },
    crawl: {
      status: "complete",
      startedAt: "2026-08-20T09:07:45.000Z",
      finishedAt: "2026-08-20T09:08:15.000Z",
    },
    pages,
    links,
  };
}
