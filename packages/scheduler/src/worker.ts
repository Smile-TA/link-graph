import {
  runCrawlCommand,
  type CrawlCommandDeps,
  type CrawlReport,
} from "@link-graph/cli";
import {
  checkExternalUrls,
  type LinkcheckDeps,
  type LinkcheckResult,
} from "@link-graph/linkcheck";
import type { ConnectionOptions, Queue } from "bullmq";
import { Worker } from "bullmq";
import type { Pool } from "pg";
import type { CrawlJobData, LinkcheckJobData } from "./queues.js";

export interface WorkerDeps {
  readonly crawl: Partial<CrawlCommandDeps>;
  readonly linkcheck: LinkcheckDeps;
}

export interface Workers {
  readonly crawl: Worker<CrawlJobData>;
  readonly linkcheck: Worker<LinkcheckJobData>;
}

/**
 * The crawl job's logic, pure enough to unit-test against fakes (guide §4.2) — the
 * BullMQ `Worker` wrapping it is the one line that cannot be tested that way. It
 * enqueues its own follow-on linkcheck job on success, onto the `linkcheckQueue` passed
 * in — the caller owns opening and closing that connection. That chaining lives here
 * rather than as a BullMQ flow: a flow would need the child defined before the parent
 * runs, but the child's payload (`crawlId`) only exists once the parent's crawl has
 * happened.
 */
export function processCrawlJob(
  pool: Pool,
  linkcheckQueue: Pick<Queue<LinkcheckJobData>, "add">,
  deps: WorkerDeps["crawl"],
): (data: CrawlJobData) => Promise<CrawlReport> {
  return async (data) => {
    const report = await runCrawlCommand(pool, data.siteId, () => {}, deps);
    await linkcheckQueue.add("after-crawl", { crawlId: report.crawl.crawlId });
    return report;
  };
}

export function processLinkcheckJob(
  pool: Pool,
  deps: WorkerDeps["linkcheck"],
): (data: LinkcheckJobData) => Promise<LinkcheckResult> {
  return async (data) => checkExternalUrls(pool, data.crawlId, deps);
}

/**
 * One worker image, two `Worker`s in the same process (PRD §8) — isolation is between
 * queues, not between containers, so a crawl in progress does not block a linkcheck run
 * and either can be scaled or restarted by adding a second process against the same
 * Redis, not by building a second image.
 *
 * Split into two functions rather than built inline here: `deps.linkcheck` needs the
 * lychee binary resolved (`resolveLycheeBinary`), which throws when the binary is
 * missing, and crawling has nothing to do with lychee. A caller that resolved both
 * deps before calling a single `createWorkers` would lose the crawl worker to a
 * linkcheck-only problem — measured, that's exactly what `bin.ts` did before this split.
 */
export function createCrawlWorker(
  pool: Pool,
  connection: ConnectionOptions,
  linkcheckQueue: Queue<LinkcheckJobData>,
  deps: WorkerDeps["crawl"],
): Worker<CrawlJobData> {
  return new Worker<CrawlJobData>(
    "crawl",
    async (job) => processCrawlJob(pool, linkcheckQueue, deps)(job.data),
    { connection },
  );
}

export function createLinkcheckWorker(
  pool: Pool,
  connection: ConnectionOptions,
  deps: WorkerDeps["linkcheck"],
): Worker<LinkcheckJobData> {
  return new Worker<LinkcheckJobData>(
    "linkcheck",
    async (job) => processLinkcheckJob(pool, deps)(job.data),
    { connection },
  );
}

export function createWorkers(
  pool: Pool,
  connection: ConnectionOptions,
  linkcheckQueue: Queue<LinkcheckJobData>,
  deps: WorkerDeps,
): Workers {
  return {
    crawl: createCrawlWorker(pool, connection, linkcheckQueue, deps.crawl),
    linkcheck: createLinkcheckWorker(pool, connection, deps.linkcheck),
  };
}
