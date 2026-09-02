/**
 * `link-graph crawl <site-id>`: the four steps built before this one, in order.
 *
 *     registry row → resolveTruthSource (step 5) → crawl (step 6) → analyse (step 4)
 *                  → the orphan table (report.ts)
 *
 * Wiring, in the sense of engineering guide §4.1 — every rule this command depends on
 * already lives behind one of those four seams, and none of them is restated here. What
 * this file adds is the order, the two registry refusals that must happen before any
 * request is made, and one write: the resolved truth source goes back onto the site row.
 *
 * **Why that write is not optional.** `analyse` reads `sites.truth_source` to decide
 * whether the orphan question can be answered at all, and `crawl` reads it to decide
 * whether an inventory is allowed to seed the frontier. A row left at NULL after a
 * resolution that found 13 REST pages would make the crawler refuse its own seeds — and
 * a row still saying `rest` after the API went away would report orphans against an
 * inventory nobody could read. The resolution is a fact about the site, and this is the
 * column that holds it.
 */
import { analyse } from "@link-graph/analyse";
import { crawl } from "@link-graph/crawl";
import type { CrawlDeps } from "@link-graph/crawl";
import {
  listOrphanFindings,
  upsertSite,
  type SiteRow,
  type TruthSource,
} from "@link-graph/db";
import { createHttpFetcher, resolveTruthSource, type TruthDeps } from "@link-graph/truth";
import type { Pool } from "pg";
import { UsageError } from "./exit.js";
import { siteBySlug } from "./registry.js";
import { reportProblem, type CrawlReport } from "./report.js";
import { crawlSeeds } from "./seeds.js";

export interface CrawlCommandDeps {
  /** The truth resolver's HTTP GET. Defaults to the real, 1 req/s-paced one. */
  readonly truth: TruthDeps;
  /** The crawler's own injection seam (PRD §5.0), passed straight through. */
  readonly crawl: Partial<CrawlDeps>;
}

/**
 * `progress` is a parameter rather than a member of `deps` because it is not I/O this
 * function chooses: a full crawl of the largest non-sampled site in the estate is ~33
 * minutes at 1 req/s, and a command that says nothing for half an hour is a command
 * people kill — so every caller has to answer where that goes, and none may default it
 * to silence.
 */
export async function runCrawlCommand(
  pool: Pool,
  siteId: string,
  progress: (line: string) => void,
  deps: Partial<CrawlCommandDeps> = {},
): Promise<CrawlReport> {
  const site = await registrySite(pool, siteId);

  progress(`resolving the truth source for ${site.canonicalHost}…`);
  const truth = await resolveTruthSource(
    { siteId: site.siteId, canonicalHost: site.canonicalHost, aliases: site.aliases },
    deps.truth ?? createHttpFetcher(),
  );
  // The assignment `packages/truth` names as the seam between the two vocabularies: a
  // `TruthSourceKind` that is not a `TruthSource` is a compile error here rather than a
  // constraint violation at INSERT.
  const resolved: TruthSource = truth.kind;
  const registryWas = site.truthSource;
  // Only when it moved. `upsertSite` writes all eleven columns, nine of which are the
  // curation overlay's (PRD §3) and none of which this command owns, so a blind
  // read-modify-write on every crawl is a wider write than the one fact learned here.
  const crawled =
    resolved === registryWas
      ? site
      : await upsertSite(pool, { ...site, truthSource: resolved });

  const seeds = crawlSeeds(truth);
  progress(
    `crawling ${site.canonicalHost}: ${seeds.urls.length} inventory URL(s) at ` +
      `${site.rateLimit} req/s…`,
  );
  // A partial crawl throws (`PartialCrawlError`) rather than returning, so there is no
  // branch here that could carry a subset of a site into the analysis.
  const result = await crawl(pool, crawled, seeds, deps.crawl ?? {});

  progress(`analysing crawl ${result.crawlId}: ${result.pages} page(s)…`);
  const metrics = await analyse(pool, result.crawlId);
  // `listOrphanFindings` and not `listPages` filtered here: the report path (step 7.6)
  // reads the same rows, and "this crawl's orphan rows" defined twice is exactly the
  // disagreement `orphanListProblem` exists to catch. It also stops fetching all 2,454
  // page rows of a large crawl to keep four of them.
  const orphans = (await listOrphanFindings(pool, result.crawlId)).map((page) => ({
    urlNormalized: page.urlNormalized,
    statusCode: page.statusCode,
  }));

  const report: CrawlReport = {
    siteId: site.siteId,
    canonicalHost: site.canonicalHost,
    truth: {
      kind: truth.kind,
      registryWas,
      inventory: truth.counts.total,
      rest: truth.counts.rest,
      sitemap: truth.counts.sitemap,
      requests: truth.requests,
      findings: truth.findings,
    },
    crawl: {
      crawlId: result.crawlId,
      pages: result.pages,
      links: result.links,
      aliasHops: result.aliasHops,
      wasThrottled: result.wasThrottled,
      pending: result.pending,
    },
    metrics,
    orphans,
  };
  const problem = reportProblem(report);
  // Nothing downstream can recover from the count and the list disagreeing, and printing
  // either one would be picking a winner at random.
  if (problem !== null) throw new Error(`crawl ${result.crawlId}: ${problem}`);
  return report;
}

/**
 * The registry row, refused before a single request is made.
 *
 * Both refusals are `UsageError`s: the remedy is in the registry, the estate is fine,
 * and nothing was crawled. The first of the two is shared with `note` and `report`
 * (`registry.ts`); the second is this command's alone, because they read a crawl that
 * has already happened.
 */
async function registrySite(pool: Pool, siteId: string): Promise<SiteRow> {
  const site = await siteBySlug(pool, siteId);
  if (!site.enabled) {
    // PRD §3.1: an entry the platform does not serve enters the registry as
    // `enabled: false` and the liveness probe flips it on when it migrates. Crawling
    // one anyway produces a page list for a site that is not deployed.
    throw new UsageError(
      `site ${site.siteId} is in the registry with enabled = false, which means the ` +
        `liveness probe has not seen it served by the platform (PRD §3.1). Crawling it ` +
        `would report on a site that is not deployed`,
    );
  }
  return site;
}
