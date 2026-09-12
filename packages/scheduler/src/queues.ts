import { Queue, type ConnectionOptions } from "bullmq";

/**
 * Two queues, not the architecture diagram's three (PRD §8). `analyse` never runs on
 * its own anywhere in this codebase — `runCrawlCommand` (step 7) always follows a crawl
 * with its analysis in the same call, and nothing here needs to retry one without the
 * other. A queue with no distinct job to carry is speculative isolation, so `crawl`
 * carries both, and `linkcheck` stays separate because it is genuinely independent: a
 * different external host per job, its own TTL-driven due set, and a failure that must
 * not block or repeat the crawl that fed it.
 */
export const QUEUE_NAMES = ["crawl", "linkcheck"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export interface CrawlJobData {
  readonly siteId: string;
}

export interface LinkcheckJobData {
  readonly crawlId: number;
}

export function redisConnection(url: string): ConnectionOptions {
  return { url, maxRetriesPerRequest: null };
}

export interface Queues {
  readonly crawl: Queue<CrawlJobData>;
  readonly linkcheck: Queue<LinkcheckJobData>;
}

export function createQueues(connection: ConnectionOptions): Queues {
  return {
    crawl: new Queue<CrawlJobData>("crawl", { connection }),
    linkcheck: new Queue<LinkcheckJobData>("linkcheck", { connection }),
  };
}
