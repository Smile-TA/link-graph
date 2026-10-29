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
import { siteHosts } from "@link-graph/core";
import { crawl } from "@link-graph/crawl";
import type { CrawlDeps } from "@link-graph/crawl";
import { crawlsToPrune, diffCrawls } from "@link-graph/diffs";
import {
  findPreviousCompleteCrawl,
  insertCrawlDiffs,
  listBrokenLinkFindings,
  listCompleteCrawlIds,
  listOrphanFindings,
  pruneCrawlDetail,
  upsertSite,
  withTransaction,
  type CrawlEnv,
  type SiteRow,
  type TruthSource,
} from "@link-graph/db";
import {
  createHttpFetcher,
  resolveTruthSource,
  TruthSourceUnresolvedError,
  type TruthDeps,
  type TruthSourceResult,
} from "@link-graph/truth";
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
  env: CrawlEnv = "prod",
): Promise<CrawlReport> {
  const site = await registrySite(pool, siteId);
  if (env === "stage" && site.stageHost === null) {
    throw new UsageError(
      `site ${site.siteId} has no stage host configured, so it cannot be crawled with ` +
        `--stage`,
    );
  }
  // Which host the truth source and the crawl itself resolve against — the site's own
  // prod host and aliases, or the stage host alone (step 14). `@link-graph/core`'s
  // `siteHosts` makes the same choice from the same site row and `env`, so `crawl`
  // (which calls it independently) never derives identity a second, different way.
  const hosts = siteHosts(site, env === "stage");

  progress(`resolving the truth source for ${hosts.canonicalHost}…`);
  let truth: TruthSourceResult;
  try {
    truth = await resolveTruthSource(
      { siteId: site.siteId, canonicalHost: hosts.canonicalHost, aliases: hosts.aliases },
      deps.truth ?? createHttpFetcher(),
    );
  } catch (error) {
    // A site the registry already records as `none` has been looked at and curated: its
    // REST and sitemap are known not to be usable (theme pages answer where JSON or XML
    // should, measured 2026-10-27 on seven sites), so an unreadable source is what we
    // expect and the crawl proceeds for links and structure, with orphans undetectable.
    // A site that is not recorded as `none` still fails loudly.
    if (!(error instanceof TruthSourceUnresolvedError) || site.truthSource !== "none") {
      throw error;
    }
    progress(`truth source unreadable (registry says none); crawling without one`);
    truth = {
      kind: "none",
      urls: [],
      postTypes: [],
      counts: { total: null, rest: null, sitemap: null },
      taxonomies: [],
      findings: error.findings,
      requests: 0,
    };
  }
  // The assignment `packages/truth` names as the seam between the two vocabularies: a
  // `TruthSourceKind` that is not a `TruthSource` is a compile error here rather than a
  // constraint violation at INSERT.
  const resolved: TruthSource = truth.kind;
  const registryWas = site.truthSource;
  // Only when it moved, and only for a prod crawl. `sites.truth_source` is read
  // elsewhere as a fact about the site's real deployment (`analyse`'s coverage gate,
  // step 9's coverage-drift report) — a staging host's resolution overwriting it would
  // corrupt that fact with something learned from a different server. `upsertSite`
  // writes all eleven columns, nine of which are the curation overlay's (PRD §3) and
  // none of which this command owns, so a blind read-modify-write on every crawl is a
  // wider write than the one fact learned here.
  const crawled =
    env === "prod" && resolved !== registryWas
      ? await upsertSite(pool, { ...site, truthSource: resolved })
      : site;

  const seeds = crawlSeeds(truth);
  progress(
    `crawling ${hosts.canonicalHost}: ${seeds.urls.length} inventory URL(s) at ` +
      `${site.rateLimit} req/s…`,
  );
  // `crawl`'s own `seedProblem` checks that `truthSource` and the seed list agree
  // (006_truth_source.sql's invariant) — a check about *this run's* resolution, not
  // about the registry row. For a stage crawl that resolution is deliberately not
  // written back (above), so it is given here instead, in memory only: `crawled.id` is
  // unchanged, and `analyse` afterward reads the site fresh from the database and sees
  // the real, untouched `truthSource`.
  const crawlSite = env === "stage" ? { ...crawled, truthSource: resolved } : crawled;
  // A partial crawl throws (`PartialCrawlError`) rather than returning, so there is no
  // branch here that could carry a subset of a site into the analysis.
  const result = await crawl(pool, crawlSite, seeds, deps.crawl ?? {}, env);

  progress(`analysing crawl ${result.crawlId}: ${result.pages} page(s)…`);
  const metrics = await analyse(pool, result.crawlId);
  // `listOrphanFindings` and not `listPages` filtered here: the report path (step 7.6)
  // reads the same rows, and "this crawl's orphan rows" defined twice is exactly the
  // disagreement `orphanListProblem` exists to catch. It also stops fetching all 2,454
  // page rows of a large crawl to keep four of them.
  const orphanRows = await listOrphanFindings(pool, result.crawlId);
  const orphans = orphanRows.map((page) => ({
    urlNormalized: page.urlNormalized,
    statusCode: page.statusCode,
  }));

  // Step 13: diff against this site's last complete crawl, and prune row-level detail
  // beyond the 12-crawl retention window (PRD §7). Two unrelated facts about this
  // crawl's row, which already exists by this point — run concurrently.
  await Promise.all([
    recordCrawlDiff(pool, crawled.id, result.crawlId, orphanRows),
    pruneRetention(pool, crawled.id),
  ]);

  const report: CrawlReport = {
    siteId: site.siteId,
    // The host this run actually crawled — prod's canonical host, or the stage host
    // under `--stage` — not necessarily `site.canonicalHost`, which the report must not
    // claim to describe when this run never fetched a single page of it.
    canonicalHost: hosts.canonicalHost,
    env,
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
 * Step 13: what changed since this site's previous complete crawl. A no-op on the
 * site's first crawl (`findPreviousCompleteCrawl` returns `null`).
 *
 * `orphanRows` is the current crawl's already-fetched list, not re-queried — the same
 * "don't ask the same question twice" reasoning `orphans` above follows. The previous
 * crawl's findings and both crawls' broken-link lists are read fresh, because nothing
 * upstream needed them.
 */
async function recordCrawlDiff(
  pool: Pool,
  siteId: number,
  crawlId: number,
  orphanRows: Awaited<ReturnType<typeof listOrphanFindings>>,
): Promise<void> {
  const previous = await findPreviousCompleteCrawl(pool, siteId, crawlId);
  if (previous === null) return;

  const [previousOrphans, currentBroken, previousBroken] = await Promise.all([
    listOrphanFindings(pool, previous.id),
    listBrokenLinkFindings(pool, crawlId),
    listBrokenLinkFindings(pool, previous.id),
  ]);
  const diffs = diffCrawls({
    previousOrphans: previousOrphans.map((page) => page.urlNormalized),
    currentOrphans: orphanRows.map((page) => page.urlNormalized),
    previousBroken: previousBroken.map((link) => link.urlNormalized),
    currentBroken: currentBroken.map((link) => link.urlNormalized),
    previousTag: previous.deployedTag,
    // No caller resolves `image.tag` onto a crawl row yet — `crawl()` always writes
    // `deployedTag: null` (packages/crawl/src/crawl.ts) — so this is always null in
    // practice today.
    currentTag: null,
  });
  // One transaction, not one write per diff: a run that fails partway through a
  // multi-hundred-row diff must not leave this crawl pair's history half recorded —
  // the next report would then read a diff that undercounts what actually changed.
  await withTransaction(pool, async (tx) => {
    await insertCrawlDiffs(
      tx,
      diffs.map((diff) => ({
        fromCrawlId: previous.id,
        toCrawlId: crawlId,
        kind: diff.kind,
        url: diff.url,
        detail: diff.detail,
      })),
    );
  });
}

/** Step 13's retention: drop row-level detail beyond the 12-crawl window (PRD §7). */
async function pruneRetention(pool: Pool, siteId: number): Promise<void> {
  const completeCrawlIds = await listCompleteCrawlIds(pool, siteId);
  await pruneCrawlDetail(pool, crawlsToPrune(completeCrawlIds));
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
