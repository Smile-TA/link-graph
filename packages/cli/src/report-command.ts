/**
 * `link-graph report <site-id>`: the site's last complete crawl, re-read.
 *
 *     registry row → latest complete crawl → its metrics → its findings
 *                  → this site's reviews → the three-way split (site-report.ts)
 *
 * **It measures nothing and writes nothing.** No network, no `analyse`, no `pages.class`
 * or `crawl_metrics` write — PRD §7.1 rule 1 is that a review never changes a measured
 * number, and the strongest form of that is a read path that has no way to. Everything
 * printed was committed by the crawl that produced it.
 *
 * Both refusals below are loud for the same reason: this command's whole job is to say
 * how many findings a site has, so a missing crawl or a missing metrics row must not
 * come out as a site with nothing to report.
 */
import {
  countCrawlRows,
  findCrawlMetrics,
  findLatestCompleteCrawl,
  listBrokenLinkFindings,
  listOrphanFindings,
} from "@link-graph/db";
import {
  brokenLinkFinding,
  bucketFindings,
  orphanFinding,
  reviewsFor,
} from "@link-graph/review";
import type { Pool } from "pg";
import { siteBySlug } from "./registry.js";
import { siteReportProblem, type SiteReport } from "./site-report.js";

export async function runReportCommand(pool: Pool, siteId: string): Promise<SiteReport> {
  const site = await siteBySlug(pool, siteId);
  const crawl = await findLatestCompleteCrawl(pool, site.id);
  if (crawl === null) {
    // Not a `UsageError`: the invocation is right and the site is known. There is
    // nothing to report yet, which is a different fact from "nothing was found".
    throw new Error(
      `no complete crawl of ${site.siteId} to report on. A partial crawl holds an ` +
        `arbitrary subset of a site and is never reported as one (engineering guide ` +
        `§1), so run \`link-graph crawl ${site.siteId}\` first`,
    );
  }
  const metrics = await findCrawlMetrics(pool, crawl.id);
  if (metrics === null) {
    throw new Error(
      `crawl ${crawl.id} of ${site.siteId} has no crawl_metrics row, so \`analyse\` ` +
        `has never run over it and there are no numbers to report. Nothing here will ` +
        `count its pages instead: that would be a second implementation of the orphan ` +
        `set difference, printed as though it were the stored one`,
    );
  }

  // One wave rather than five: none of these six reads depends on another, and the
  // broken-link aggregate walks every internal link of the crawl (127,845 of them on
  // integrity.com), so awaiting them in sequence makes the command's wall time their
  // sum. They take the pool, not one client, so `pg` runs them on separate connections.
  const [counts, orphanRows, brokenRows, orphanReviews, brokenReviews] =
    await Promise.all([
      countCrawlRows(pool, crawl.id),
      // Listed whatever the count says, so that a crawl whose classified pages and whose
      // metrics row disagree is refused by `siteReportProblem` below rather than
      // reconciled here by dropping one of the two.
      listOrphanFindings(pool, crawl.id),
      listBrokenLinkFindings(pool, crawl.id),
      reviewsFor(pool, site.id, "orphan"),
      reviewsFor(pool, site.id, "broken_internal_link"),
    ]);

  const report: SiteReport = {
    siteId: site.siteId,
    canonicalHost: site.canonicalHost,
    truthSource: site.truthSource,
    crawl: {
      finishedAt: crawl.finishedAt,
      // The rows that exist, not `crawls.pages_seen`, which is the crawl's own count of
      // what it thought it wrote.
      pages: counts.pages,
      links: counts.links,
      truthSourceUrls: crawl.truthSourceUrls,
      wasThrottled: crawl.wasThrottled,
    },
    metrics,
    orphans: bucketFindings(orphanRows.map(orphanFinding), orphanReviews),
    brokenLinks: bucketFindings(brokenRows.map(brokenLinkFinding), brokenReviews),
  };
  const problem = siteReportProblem(report);
  // Nothing downstream can recover from two numbers for one question, and printing
  // either is picking a winner at random (the same rule `run.ts` applies).
  if (problem !== null) throw new Error(`crawl ${crawl.id}: ${problem}`);
  return report;
}
