/**
 * The dashboard's read model: the sites catalog and one site's capture, shaped as the
 * Link Graph PR pack's API contract (`GraphSite`, `GraphSnapshot`). The pack's own
 * `server/captures.ts` fetched these over HTTP from a separate API at build time and wrote
 * them to a generated cache; here the same module name answers from `@link-graph/db`
 * directly (PRD §9's "one data layer"), so the pack's pages import it unchanged and there
 * is no second API process to keep alive.
 *
 * "Latest capture" is `findLatestCompleteCrawl`'s: the latest *complete production* crawl.
 * Every number comes from the stored `crawl_metrics` rollup, never recomputed here, so the
 * catalog, a site page and `link-graph report` always agree.
 */
import { createHash } from "node:crypto";
import {
  countLinksPerCrawl,
  listCrawlSummaries,
  listGraphBrokenEdges,
  listGraphBrokenExternalLinks,
  listGraphPages,
  listLatestCrawlMetricsPerSite,
  listLatestCrawlsPerSite,
  listSites,
} from "@link-graph/db";
import { listNextCrawlTimes } from "@link-graph/scheduler";
import type {
  GraphSite as ApiGraphSite,
  GraphSnapshot,
} from "@workspace/api-client-react";
import { pool } from "../db";
import { queues } from "../queues";

/** The pack's `GraphSite`, plus the three columns this app's sites list has always had. */
export type GraphSite = ApiGraphSite & {
  /** Complete production crawls on record (docs/notes.md item 6). */
  crawlCount: number;
  /** ISO time of the next scheduled crawl, `null` when none (or Redis is unreachable). */
  nextCrawl: string | null;
  status: "enabled" | "disabled" | "alias";
};

// A complete crawl's rows never change, so its link total is counted once per process.
const linkTotals = new Map<number, number>();

export async function getCatalog(): Promise<GraphSite[]> {
  const [sites, summaries, latest, metrics, nextRuns] = await Promise.all([
    listSites(pool),
    listCrawlSummaries(pool),
    listLatestCrawlsPerSite(pool),
    listLatestCrawlMetricsPerSite(pool),
    // Redis is a separate failure domain: a blip must still render the sites list with its
    // crawl history (docs/notes.md item 6), just without a next-crawl column.
    listNextCrawlTimes(queues.crawl).catch(() => new Map<string, Date>()),
  ]);
  const summaryBySite = new Map(summaries.map((row) => [row.siteId, row]));
  const latestBySite = new Map(latest.map((row) => [row.siteId, row]));
  const metricsBySite = new Map(metrics.map((row) => [row.siteId, row]));

  const missing = latest.map((row) => row.crawlId).filter((id) => !linkTotals.has(id));
  for (const [crawlId, total] of await countLinksPerCrawl(pool, missing))
    linkTotals.set(crawlId, total);

  return sites
    .map((site): GraphSite => {
      const crawl = latestBySite.get(site.id);
      const m = metricsBySite.get(site.id);
      const pageCount = m?.pageCount ?? 0;
      const capturedAt =
        crawl === undefined ? null : (crawl.finishedAt ?? crawl.startedAt);
      const next = nextRuns.get(site.siteId);
      const status: GraphSite["status"] =
        site.redirectTargetHost !== null
          ? "alias"
          : site.enabled
            ? "enabled"
            : "disabled";
      const row = {
        siteId: site.siteId,
        host: site.canonicalHost,
        latestCrawlAt: capturedAt === null ? "" : capturedAt.toISOString(),
        pageCount,
        orphanCount: m?.orphans ?? null,
        unresolvedInternalLinks: m?.internalUnresolved ?? 0,
        brokenLinks: m?.broken ?? 0,
        externalDestinations: m?.external ?? 0,
        totalLinkRows: crawl === undefined ? 0 : (linkTotals.get(crawl.crawlId) ?? 0),
        sampleLabel:
          crawl === undefined ? "No production capture" : "Complete production capture",
        crawlId: crawl === undefined ? null : String(crawl.crawlId),
        crawlStatus: crawl === undefined ? "not captured" : "complete",
        // A crawl with no metrics row has never been analysed: say so rather than "no orphans".
        orphanUnknownReason:
          m === undefined
            ? crawl === undefined
              ? null
              : "metrics not recorded"
            : (m.orphansUnknownReason ?? null),
        enabled: site.enabled,
        crawlCount: summaryBySite.get(site.id)?.completeCrawlCount ?? 0,
        nextCrawl: site.enabled && next !== undefined ? next.toISOString() : null,
        status,
      };
      // The cache identity of this capture: changes when the crawl, its rollup or its page
      // count does, which is exactly when a browser's cached snapshot stops being right.
      const captureVersion = createHash("sha256")
        .update(JSON.stringify({ ...row, nextCrawl: null }))
        .digest("hex");
      return { ...row, captureVersion };
    })
    .sort(
      (a, b) =>
        a.host.toLowerCase().localeCompare(b.host.toLowerCase()) ||
        a.siteId.localeCompare(b.siteId),
    );
}

const SNAPSHOT_CACHE_SIZE = 6;
const snapshots = new Map<string, Promise<Omit<GraphSnapshot, "brokenExternalLinks">>>();

/**
 * One site's latest capture without its edges — pages and broken links only. Edges are
 * fetched on demand (`/api/link-graph/.../connections`) because only two views need them.
 * Cached by capture identity: a complete crawl is immutable, and a 60,000-page snapshot is
 * not something to rebuild per request.
 */
export async function getSnapshot(siteId: string): Promise<GraphSnapshot> {
  const capture = await getCapture(siteId);
  // Not part of the cached capture: the link check runs after a crawl completes and keeps
  // rewriting `external_urls` as URLs come due, with no change to the capture's identity.
  const brokenExternalLinks =
    capture.site.crawlId === null
      ? []
      : await listGraphBrokenExternalLinks(pool, Number(capture.site.crawlId));
  return { ...capture, brokenExternalLinks };
}

async function getCapture(
  siteId: string,
): Promise<Omit<GraphSnapshot, "brokenExternalLinks">> {
  const site = (await getCatalog()).find((row) => row.siteId === siteId);
  if (site === undefined) throw new Error(`unknown site ${siteId}`);
  const key = `${site.siteId}:${site.captureVersion ?? ""}`;
  const cached = snapshots.get(key);
  if (cached !== undefined) return cached;

  const task = (async (): Promise<Omit<GraphSnapshot, "brokenExternalLinks">> => {
    const crawlId = site.crawlId === null ? null : Number(site.crawlId);
    const [pages, brokenLinks] =
      crawlId === null
        ? [[], []]
        : await Promise.all([
            listGraphPages(pool, crawlId),
            listGraphBrokenEdges(pool, crawlId),
          ]);
    return {
      site,
      // The schema has no page title column, and inventing HTML titles would be a guess.
      pages: pages.map((page) => ({
        ...page,
        title: page.path === "/" ? "Home" : page.path,
      })),
      edges: [],
      brokenLinks,
      source: "database",
      description: `Local PostgreSQL snapshot · ${site.sampleLabel} · ${site.latestCrawlAt || "no crawl date"}. Page titles were not stored; paths are shown instead.`,
    };
  })();
  snapshots.set(key, task);
  task.catch(() => snapshots.delete(key));
  while (snapshots.size > SNAPSHOT_CACHE_SIZE) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
  return task;
}
