/**
 * `analyse(crawlId) → CrawlMetrics` — the orphan set difference.
 *
 * Built before the crawler on purpose (implementation plan, ordering rule 2): seeded
 * from a fixture the correct answer is known, and against a live crawl of a 2,000-page
 * site nobody knows it, so a bug in the set difference would be indistinguishable from a
 * real finding.
 *
 * The shape follows engineering guide §4.1: the graph maths is SQL in `@link-graph/db`
 * (`repo/analysis.ts`), the taxonomy is a pure function (`classify.ts`), and this file is
 * wiring plus the refusals. Every refusal here exists because the alternative is a number
 * that reads as good news — §1's one rule.
 */
import { normalizeUrl } from "@link-graph/core";
import type { Pool } from "pg";
import {
  countAnalysedLinks,
  countFetchedPages,
  countTruthSourcePages,
  computePageDepths,
  findCrawl,
  findPageByUrl,
  findSiteById,
  listPageAnalysisFacts,
  markBoilerplateLinks,
  setPageClasses,
  upsertCrawlMetrics,
  withTransaction,
  type CrawlMetricsInput,
  type SiteRow,
} from "@link-graph/db";
import {
  classifyPage,
  orphansUnknownReason,
  type PageClass,
  type SiteRules,
} from "./classify.js";
import {
  DEFAULT_MIN_TRUTH_SOURCE_COVERAGE_PCT,
  truthSourceCoverageProblem,
} from "./coverage.js";

export interface AnalyseOptions {
  /**
   * N from PRD §6: an edge whose `(target, anchor)` pair appears on more than this
   * percentage of the crawl's fetched pages is boilerplate. Default 60.
   *
   * **Still unresolved, and deliberately a parameter rather than a constant.** PRD §15
   * lists N as open and the plan expects it decided from data; the only data that exists
   * before step 6 is one small site, where the answer happens to be insensitive to it
   * (see the note in `analyse.int.test.ts`). Estate-wide calibration needs step 7's first
   * real crawl.
   */
  readonly boilerplateThresholdPct?: number;
  /**
   * The share of the truth source a crawl must have page rows for before its orphan
   * counts mean anything. Default 90, and a parameter because no measurement pins it —
   * see `coverage.ts`, which holds both the rule and the reasoning.
   */
  readonly minTruthSourceCoveragePct?: number;
}

const DEFAULT_BOILERPLATE_THRESHOLD_PCT = 60;

export async function analyse(
  pool: Pool,
  crawlId: number,
  options: AnalyseOptions = {},
): Promise<CrawlMetricsInput> {
  const thresholdPct = percentage(
    "boilerplateThresholdPct",
    options.boilerplateThresholdPct,
    DEFAULT_BOILERPLATE_THRESHOLD_PCT,
  );
  const coveragePct = percentage(
    "minTruthSourceCoveragePct",
    options.minTruthSourceCoveragePct,
    DEFAULT_MIN_TRUTH_SOURCE_COVERAGE_PCT,
  );

  const crawl = await findCrawl(pool, crawlId);
  if (crawl === null) throw new Error(`analyse: no crawl ${crawlId}`);
  // A crawl that ended early has an arbitrary subset of the site's pages, so every
  // count derived from it — "3 orphans" most of all — is about that subset and not
  // about the site (engineering guide §1, and the note in 004_metrics.sql).
  if (crawl.status !== "complete") {
    throw new Error(
      `analyse: crawl ${crawlId} is ${crawl.status}, not complete. A partial crawl ` +
        `never produces metrics as though its page set were the whole site.`,
    );
  }
  const site = await findSiteById(pool, crawl.siteId);
  if (site === null) {
    throw new Error(`analyse: crawl ${crawlId} references missing site ${crawl.siteId}`);
  }
  // Overlaps the homepage refusal below on purpose, and comes first on purpose: a crawl
  // that fetched nothing at all would otherwise be reported as "the homepage was never
  // fetched", which sends the reader after one page instead of the whole run.
  const fetched = await countFetchedPages(pool, crawlId);
  if (fetched === 0) {
    throw new Error(
      `analyse: crawl ${crawlId} has ${crawl.pagesSeen} page(s) and none of them was ` +
        `ever fetched, so it has no links to analyse. A crawl that fetched nothing ` +
        `must not report zero orphans.`,
    );
  }

  const homeUrl = homepageUrl(site);
  const siteRules: SiteRules = {
    truthSource: site.truthSource,
    crawlScope: site.crawlScope,
    ignorePaths: site.ignorePaths,
  };
  // What the orphan count is going to be, decided once and used twice: the gate below
  // and the metrics row at the end must not disagree about whether this crawl can
  // answer the orphan question.
  const unknownReason = orphansUnknownReason(siteRules);
  // The gate exists to stop a crawl of 1 page of 1,953 reporting `orphans: 0`. A crawl
  // that is not going to report a number at all needs no such protection — and a
  // sampled site would fail it forever by design, since covering 90% of a 59,363-page
  // inventory is the thing sampling exists not to do (PRD §15). The shortfall is
  // deliberate, so it is not a failure; `orphans_unknown_reason = 'sampled'` is how the
  // reader learns of it, which is a stronger statement than a refused run.
  if (unknownReason === null) {
    const problem = truthSourceCoverageProblem(
      await countTruthSourcePages(pool, crawlId),
      crawl.truthSourceUrls,
      coveragePct,
    );
    if (problem !== null) throw new Error(`analyse: crawl ${crawlId} — ${problem}`);
  }

  return withTransaction(pool, async (tx) => {
    const root = await findPageByUrl(tx, crawlId, homeUrl);
    if (root === null) {
      // Without the root, depth has nowhere to start and every page comes out
      // unreachable — a report opening with "every page on this site is unreachable",
      // which is a spectacular false finding rather than a missing number.
      throw new Error(
        `analyse: crawl ${crawlId} has no page row for ${homeUrl}, so reachability has ` +
          `no root. Depth would be null for every page of the crawl.`,
      );
    }

    // The row existing is not enough: reachability is measured from what the homepage
    // served, and a homepage the crawl never got a response for produces a complete,
    // plausible, entirely wrong report — measured on this fixture, under the taxonomy
    // as it stood before 2026-08-20, as 4 orphans and 6 soft orphans out of 13 with no
    // error at all, because a root with no links makes every other page unreachable.
    // The class names have changed since; the failure has not.
    if (root.statusCode === null || root.statusCode < 200 || root.statusCode >= 300) {
      throw new Error(
        `analyse: crawl ${crawlId}'s homepage ${homeUrl} ` +
          `${root.statusCode === null ? "was never fetched" : `returned ${root.statusCode}`}` +
          `, so reachability has no usable root. Every other page would come out ` +
          `unreachable and every truth-source page an orphan.`,
      );
    }

    await markBoilerplateLinks(tx, crawlId, thresholdPct);
    await computePageDepths(tx, crawlId, root.id);

    const facts = await listPageAnalysisFacts(tx, crawlId);
    const classes = facts.map((page) => ({
      id: page.id,
      class: classifyPage({ ...page, isCrawlRoot: page.id === root.id }, siteRules),
    }));
    const written = await setPageClasses(tx, crawlId, classes);
    if (written !== classes.length) {
      throw new Error(
        `analyse: classified ${classes.length} pages of crawl ${crawlId} but wrote ` +
          `${written}`,
      );
    }

    const links = await countAnalysedLinks(tx, crawlId);
    if (links.total === 0) {
      // A fetched crawl with no edges is an empty result, and engineering guide §1
      // requires an empty result to be a loud error rather than an answer: every
      // truth-source page would be reported as a true orphan. On this fixture that is
      // 12 of 13 pages — the maximal version of the false-positive risk PRD §13 names.
      throw new Error(
        `analyse: crawl ${crawlId} fetched ${fetched} page(s) and extracted no links ` +
          `at all, so every page looks orphaned. Check link extraction before ` +
          `believing any orphan count from this crawl.`,
      );
    }
    if (links.unmarked > 0) {
      // No page class depends on `is_boilerplate` any more (the soft-orphan class was
      // dropped), so this no longer guards the taxonomy — it guards the boilerplate
      // pass itself. An edge left NULL is neither boilerplate nor contextual to every
      // query that reads it, including PRD §9's section matrix, and a pass that
      // silently skipped rows would otherwise leave no trace.
      throw new Error(
        `analyse: ${links.unmarked} link(s) of crawl ${crawlId} were left unmarked by ` +
          `the boilerplate pass`,
      );
    }

    const count = (of: PageClass) => classes.filter((c) => c.class === of).length;
    // Null, never zero, and never without saying why (PRD §2, §15): no inventory to
    // difference against, or a sample that never saw the whole of one. `classifyPage`
    // reads the same rule, so `undetectable` holds exactly the pages this count is
    // silent about.
    const metrics: CrawlMetricsInput = {
      crawlId,
      orphans: unknownReason === null ? count("orphan") : null,
      orphansUnknownReason: unknownReason,
      linked: count("linked"),
      excluded: count("excluded"),
      notInTruthSource: count("not_in_truth_source"),
      undetectable: count("undetectable"),
      unreachable: facts.filter((page) => page.depth === null).length,
      broken: links.broken,
      internalUnresolved: links.internalUnresolved,
      external: links.external,
      boilerplateThresholdPct: thresholdPct,
    };
    await upsertCrawlMetrics(tx, metrics);
    return metrics;
  });
}

/** An option that is a percentage, validated once for every option that is one. */
function percentage(name: string, value: number | undefined, fallback: number): number {
  const pct = value ?? fallback;
  if (!(pct > 0 && pct <= 100)) {
    throw new Error(`analyse: ${name} must be in (0, 100], got ${pct}`);
  }
  return pct;
}

/**
 * The page reachability is measured from. Every site in this estate serves WordPress at
 * the domain root, and the root's identity goes through `normalizeUrl` rather than being
 * assembled here: it is matched against `pages.url_normalized`, which `normalizeUrl`
 * produced, and two independent statements of node identity for the single most
 * important node is how the depth root silently stops matching (engineering guide §2.1).
 */
function homepageUrl(site: SiteRow): string {
  const home = normalizeUrl("/", {
    canonicalHost: site.canonicalHost,
    aliases: site.aliases,
  });
  if (home === null) {
    throw new Error(
      `analyse: site ${site.siteId} has an unusable canonical host ` +
        `${JSON.stringify(site.canonicalHost)}`,
    );
  }
  return home.href;
}
