/**
 * One `crawl` queue handle for the process, the same singleton shape `db.ts` uses for
 * the Postgres pool — read-only from this side (`listNextCrawlTimes`, docs/notes.md
 * item 6's "next crawl" column): nothing here ever adds or processes a job, that stays
 * the worker's job.
 */
import { createQueues, redisConnection, redisUrl } from "@link-graph/scheduler";

export const queues = createQueues(redisConnection(redisUrl()));
