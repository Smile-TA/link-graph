/**
 * `crawl(site, seeds) → { pages, links }` (PRD §5.0) — the fetch loop.
 *
 * Wiring, in the sense of engineering guide §4.1: the rules live in `record.ts`,
 * `target.ts`, `seeds.ts`, `sample.ts`, `throttle.ts` and `verdict.ts` as pure
 * functions, the SQL lives in `@link-graph/db`, and what is left here is the order
 * things happen in and the conditions under which the crawl stops.
 *
 * **Three properties this file exists to guarantee.**
 *
 * 1. **A crawl that ends early is never a short page list.** It is `status = 'partial'`
 *    in the `crawls` row *and* a thrown `PartialCrawlError` — so a caller that ignores
 *    the outcome gets an unhandled rejection and a non-zero exit rather than a plausible
 *    result. `analyse` refuses a crawl that is not `complete`, which closes the loop.
 *    This is the pw-template bug the engineering guide opens with, in the place it
 *    originally happened.
 * 2. **Everything is written as it goes** (`write-page.ts`). A killed worker leaves a
 *    consistent prefix of the crawl and a frontier that knows exactly what is left — the
 *    measured requirement, since Wordfence's ban is an hour and a 1,953-page crawl
 *    cannot start over (guide §2.1).
 * 3. **The order is deterministic.** One request at a time per host, frontier in
 *    insertion order, so two runs of the same crawl produce the same rows in the same
 *    sequence.
 */
import { normalizeUrl, type NormalizedUrl, type SiteHosts } from "@link-graph/core";
import {
  addToFrontier,
  countCrawlRows,
  countFrontier,
  findCrawl,
  findSiteById,
  finishCrawl,
  insertCrawl,
  nextFrontierUrl,
  recordFrontierFailure,
  reopenCrawl,
  resolveLinkTargets,
  type CrawlerMode,
  type SiteRow,
} from "@link-graph/db";
import type { Pool } from "pg";
import { fetchPage, type FetchOutcome } from "./fetch-page.js";
import { FETCHERS } from "./fetcher-for-mode.js";
import { type CrawlFetcher } from "./fetcher.js";
import { createHostLimiter, type HostLimiter } from "./limiter.js";
import { recordPage } from "./record.js";
import { atSampleCeiling } from "./sample.js";
import { seedProblem, type CrawlSeeds } from "./seeds.js";
import { crawlVerdict } from "./verdict.js";
import { writePage } from "./write-page.js";

export interface CrawlDeps {
  readonly fetcher: CrawlFetcher;
  /** Shared between concurrent crawls so that one host keeps one queue (PRD §5.1). */
  readonly limiter: HostLimiter;
  readonly now: () => Date;
}

export interface CrawlResult {
  readonly crawlId: number;
  readonly status: "complete" | "partial";
  readonly pages: number;
  readonly links: number;
  /** Redirects followed inside a page fetch because they named the same node. */
  readonly aliasHops: number;
  readonly wasThrottled: boolean;
  /** From the block's `retry-after`, when this run hit one. Measured value: 3600. */
  readonly retryAfterSeconds: number | null;
  /** Frontier entries with no page row. Non-zero on a partial or sampled crawl. */
  readonly pending: number;
  /** Why the crawl stopped early, or `null` when it did not. */
  readonly stoppedBecause: string | null;
}

/**
 * Thrown instead of returned when a crawl ends early.
 *
 * A returned `{ status: 'partial' }` is a value a caller can forget to look at, and the
 * failure mode this whole project exists to avoid is a partial result that reads as a
 * finished one. Ignoring this instead terminates the process. The rows are still in the
 * database and `result.crawlId` resumes them.
 */
export class PartialCrawlError extends Error {
  constructor(readonly result: CrawlResult) {
    super(
      `crawl ${result.crawlId} is partial: ${result.stoppedBecause ?? "unknown reason"}. ` +
        `${result.pages} page(s) written, ${result.pending} still queued. Resume it with ` +
        `resumeCrawl(pool, ${result.crawlId}); it must not be analysed as a whole site.`,
    );
    this.name = "PartialCrawlError";
  }
}

/**
 * Start a crawl of `site` from `seeds` (the truth source's inventory, step 5).
 *
 * The site's homepage is always crawled, whether or not the inventory lists it:
 * reachability is measured from it and `analyse` refuses a crawl without it.
 */
export async function crawl(
  pool: Pool,
  site: SiteRow,
  seeds: CrawlSeeds,
  deps: Partial<CrawlDeps> = {},
): Promise<CrawlResult> {
  const problem = seedProblem(site, seeds);
  // Before `insertCrawl`, so a refused crawl leaves no row: a `running` crawl nobody
  // started would be indistinguishable from one a worker was killed during.
  if (problem !== null) throw new Error(`crawl: ${problem}`);

  const { crawler, release } = resolveDeps(site.crawlerMode, deps);
  let crawlId: number;
  try {
    crawlId = await openCrawl(pool, site, seeds, crawler);
  } catch (error) {
    // Opening can fail — `006_truth_source.sql`'s CHECK on the three inventory counts is
    // deliberately left to the INSERT — and `run` has not been entered yet, so its
    // `finally` cannot release the connection pool this call just created. Without this
    // the process would stay open holding one, with no crawl running in it.
    await release();
    throw error;
  }
  return run(pool, crawlId, site, false, crawler, release);
}

/** The `crawls` row and its seeded frontier: everything a resume would need. */
async function openCrawl(
  pool: Pool,
  site: SiteRow,
  seeds: CrawlSeeds,
  crawler: CrawlDeps,
): Promise<number> {
  const home = homepageUrl(site);
  const crawlRow = await insertCrawl(pool, {
    siteId: site.id,
    // Phase 1 is prod-only (PRD §8) — a decision already made, not a parameter.
    env: "prod",
    startedAt: crawler.now(),
    finishedAt: null,
    status: "running",
    // Release attribution is step 9's registry read; a value here would be invented.
    deployedTag: null,
    registrySha: null,
    pagesSeen: 0,
    wasThrottled: false,
    truthSourceUrls: seeds.truthSourceUrls,
    truthSourceRestUrls: seeds.truthSourceRestUrls,
    truthSourceSitemapUrls: seeds.truthSourceSitemapUrls,
    // The vocabulary that turns the post types below into PRD §4's Excluded decision.
    // Stored on the crawl so that a later `analyse` classifies against the vocabulary
    // this crawl was seeded with (010).
    taxonomies: seeds.taxonomies,
  });

  // The homepage goes in first so that it is fetched first — and, under a sample
  // ceiling, so that it is fetched at all. `in_truth_source` is true only if the
  // inventory actually lists it; `addToFrontier` keeps the first answer, so the seed
  // below cannot change it.
  const seeded = seeds.urls.find((seed) => seed.url === home);
  await addToFrontier(pool, crawlRow.id, [
    {
      urlNormalized: home,
      inTruthSource: seeded !== undefined,
      // The inventory's own post type for the homepage when it lists one; null is the
      // honest answer when it does not, and `addToFrontier` keeps this first row.
      postType: seeded?.postType ?? null,
    },
    ...seeds.urls.map((seed) => ({
      urlNormalized: seed.url,
      inTruthSource: true,
      postType: seed.postType,
    })),
  ]);
  return crawlRow.id;
}

/**
 * Carry on a crawl that did not finish — a killed worker's, or one a host block stopped.
 *
 * The site is read from the crawl rather than passed in: a resume that used a different
 * alias set than the original run would change node identity halfway through one graph.
 */
export async function resumeCrawl(
  pool: Pool,
  crawlId: number,
  deps: Partial<CrawlDeps> = {},
): Promise<CrawlResult> {
  const crawlRow = await findCrawl(pool, crawlId);
  if (crawlRow === null) throw new Error(`resumeCrawl: no crawl ${crawlId}`);
  const site = await findSiteById(pool, crawlRow.siteId);
  if (site === null) {
    throw new Error(
      `resumeCrawl: crawl ${crawlId} references missing site ${crawlRow.siteId}`,
    );
  }
  // Refuses a completed crawl: its page set has already been reported as the whole site.
  await reopenCrawl(pool, crawlId);
  const { crawler, release } = resolveDeps(site.crawlerMode, deps);
  // `was_throttled` is sticky across resumes: a crawl that was blocked was blocked, even
  // if a later run finished it.
  return run(pool, crawlId, site, crawlRow.wasThrottled, crawler, release);
}

/**
 * Fill in the I/O this crawl needs, and say how to release it.
 *
 * `release` rather than a pair of ownership flags: whether a limiter or a connection
 * pool may be torn down is knowable only where it was created, and an injected one
 * belongs to a caller that may be crawling 15 other hosts through it (PRD §5.1's
 * "parallelise across hosts freely").
 */
function resolveDeps(
  mode: CrawlerMode,
  deps: Partial<CrawlDeps>,
): {
  crawler: CrawlDeps;
  release: () => Promise<void>;
} {
  const fetcher = deps.fetcher;
  const limiter = deps.limiter;
  const crawler: CrawlDeps = {
    // Which fetcher is the site's, not the caller's: `crawler_mode` is a registry
    // column (PRD §5), and a `playwright` site crawled over plain HTTP is the 480
    // false orphans step 7 measured. An injected fetcher still wins — that is the
    // seam the fixture server and every unit test use.
    fetcher: fetcher ?? FETCHERS[mode](),
    limiter: limiter ?? createHostLimiter(),
    now: deps.now ?? (() => new Date()),
  };
  return {
    crawler,
    release: async () => {
      if (limiter === undefined) await crawler.limiter.stop();
      if (fetcher === undefined) await crawler.fetcher.close?.();
    },
  };
}

async function run(
  pool: Pool,
  crawlId: number,
  site: SiteRow,
  wasThrottledBefore: boolean,
  deps: CrawlDeps,
  release: () => Promise<void>,
): Promise<CrawlResult> {
  const hosts: SiteHosts = { canonicalHost: site.canonicalHost, aliases: site.aliases };
  // Keyed by the canonical host, not by the host of each request: an alias hop reaches
  // the same server and the same Wordfence, so the two must share one queue.
  const queue = deps.limiter.forHost(site.canonicalHost, site.rateLimit);
  const get = (url: string) => queue.schedule(() => deps.fetcher.get(url));

  let fetched = (await countFrontier(pool, crawlId)).fetched;
  let aliasHops = 0;
  let wasThrottled = wasThrottledBefore;
  let retryAfterSeconds: number | null = null;
  let stoppedBecause: string | null = null;

  try {
    while (!atSampleCeiling(site, fetched)) {
      const entry = await nextFrontierUrl(pool, crawlId);
      if (entry === null) break;
      const url = identityOf(entry.urlNormalized, hosts);

      const outcome = await fetchPage({ url, site: hosts, get, now: deps.now });
      if (outcome.kind !== "page") {
        // The first 503 stops this host (PRD §5.1). It is not slept off: the ban is an
        // hour, and an hour of a worker sitting still is an hour it could have spent on
        // any of the other 164 sites. A transport error stops it too — every frontier
        // URL is on this site's own host, so the failure is the host and not the page,
        // and carrying on would spend the rest of the crawl collecting the same error
        // at 1 req/s. Either way the frontier keeps the URL and a later run resumes.
        wasThrottled = wasThrottled || outcome.kind === "throttled";
        retryAfterSeconds =
          outcome.kind === "throttled" ? outcome.retryAfterSeconds : retryAfterSeconds;
        stoppedBecause = stopReason(url, outcome);
        await recordFrontierFailure(pool, crawlId, url.href, stoppedBecause);
        break;
      }

      aliasHops += outcome.aliasHops;
      // `recordPage` refuses a response it cannot represent faithfully — a compressed
      // body, an empty one. Caught here rather than left to escape, because an escaping
      // throw leaves the crawl `running` with nothing recorded against the URL, which is
      // indistinguishable from a killed worker.
      let record;
      try {
        record = recordPage({
          url,
          inTruthSource: entry.inTruthSource,
          postType: entry.postType,
          site: hosts,
          status: outcome.status,
          headers: outcome.headers,
          body: outcome.body,
          redirectTo: outcome.redirectTo,
        });
      } catch (error) {
        stoppedBecause = `cannot record ${url.href}: ${message(error)}`;
        await recordFrontierFailure(pool, crawlId, url.href, stoppedBecause);
        break;
      }
      await writePage(pool, crawlId, record, deps.now());
      fetched++;
    }
  } finally {
    await release();
  }

  await resolveLinkTargets(pool, crawlId);
  const counts = await countCrawlRows(pool, crawlId);
  const frontier = await countFrontier(pool, crawlId);
  if (counts.pages !== frontier.fetched) {
    // The two are equal by construction — one transaction writes the page row and marks
    // the frontier entry — so a disagreement means one of the two writes happened
    // without the other, and `pages_seen` would then describe neither.
    throw new Error(
      `crawl ${crawlId} has ${counts.pages} page row(s) but ${frontier.fetched} ` +
        `frontier entries marked fetched. One of the two is wrong, and every count ` +
        `from this crawl is measured against it.`,
    );
  }

  const verdict = crawlVerdict(site, {
    stoppedBecause,
    pending: frontier.pending,
    pages: counts.pages,
  });
  await finishCrawl(pool, crawlId, {
    status: verdict.status,
    finishedAt: deps.now(),
    pagesSeen: counts.pages,
    wasThrottled,
  });

  const result: CrawlResult = {
    crawlId,
    status: verdict.status,
    pages: counts.pages,
    links: counts.links,
    aliasHops,
    wasThrottled,
    retryAfterSeconds,
    pending: frontier.pending,
    stoppedBecause: verdict.stoppedBecause,
  };
  if (result.status === "partial") throw new PartialCrawlError(result);
  return result;
}

function stopReason(
  url: NormalizedUrl,
  outcome: Exclude<FetchOutcome, { kind: "page" }>,
) {
  return outcome.kind === "throttled"
    ? `throttled: ${outcome.detail}`
    : `fetch failed for ${url.href}: ${outcome.detail}`;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The frontier stores node identity, and this re-derives it rather than trusting it. A
 * URL that no longer normalizes to itself would mean the alias set changed under a
 * running crawl, and the page fetched would be filed under a name nothing else uses.
 */
function identityOf(urlNormalized: string, hosts: SiteHosts): NormalizedUrl {
  const url = normalizeUrl(urlNormalized, hosts);
  if (url === null || url.href !== urlNormalized) {
    throw new Error(
      `crawl: frontier entry ${urlNormalized} is not the identity this site would ` +
        `store (${url?.href ?? "not a crawlable URL"}). The site's aliases have ` +
        `changed since the crawl was seeded.`,
    );
  }
  return url;
}

/**
 * The page reachability is measured from. Every site in this estate serves WordPress at
 * the domain root, and the root's identity goes through `normalizeUrl` for the reason
 * `analyse` gives at its own copy of this: it is matched against `pages.url_normalized`,
 * and two independent statements of identity for the single most important node is how
 * the depth root silently stops matching.
 *
 * **This is the second copy, which is the point at which it should be lifted** — into
 * `core`, beside `normalizeUrl`. Not done here because the first copy is inside
 * `packages/analyse`, committed in step 4, and step 6 does not otherwise touch it.
 */
function homepageUrl(site: SiteRow): string {
  const home = normalizeUrl("/", {
    canonicalHost: site.canonicalHost,
    aliases: site.aliases,
  });
  if (home === null) {
    throw new Error(
      `crawl: site ${site.siteId} has an unusable canonical host ` +
        `${JSON.stringify(site.canonicalHost)}`,
    );
  }
  return home.href;
}
