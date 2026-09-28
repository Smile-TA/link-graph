#!/usr/bin/env node
/**
 * The worker image's entrypoint (PRD §8): one process, both queues, and the weekly
 * schedule registered on every start-up so nothing external has to trigger it — this
 * is the whole of "Jenkins does nothing".
 */
import { databaseUrl, createPool, listSites } from "@link-graph/db";
import { createLycheeRunner, resolveLycheeBinary } from "@link-graph/linkcheck";
import type { Worker } from "bullmq";
import {
  createQueues,
  redisConnection,
  redisUrl,
  scheduleWeeklyCrawls,
  createCrawlWorker,
  createLinkcheckWorker,
} from "./index.js";
import type { LinkcheckJobData } from "./queues.js";

const pool = createPool(databaseUrl());
const connection = redisConnection(redisUrl());
const queues = createQueues(connection);

const crawlWorker = createCrawlWorker(pool, connection, queues.linkcheck, {});

// Resolved separately from the crawl worker, and allowed to fail without it: a missing
// lychee binary is a linkcheck problem, and crawling has nothing to do with lychee — see
// createWorkers's doc comment for the incident this replaced.
let linkcheckWorker: Worker<LinkcheckJobData> | undefined;
try {
  linkcheckWorker = createLinkcheckWorker(pool, connection, {
    runner: createLycheeRunner({ binaryPath: resolveLycheeBinary(process.env) }),
    now: () => new Date(),
  });
} catch (error) {
  process.stderr.write(
    `link-graph-worker: linkcheck disabled: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}

const sites = await listSites(pool);
const { scheduled, skipped } = await scheduleWeeklyCrawls(queues.crawl, sites);
process.stdout.write(
  `link-graph-worker: ${scheduled.length} site(s) scheduled weekly, ` +
    `${skipped.length} disabled site(s) skipped\n`,
);

// A killed container must let its in-flight job finish rather than losing it, and must
// not leave the Postgres pool or the Redis connections open behind it.
async function shutdown(): Promise<void> {
  await Promise.all([crawlWorker.close(), linkcheckWorker?.close()]);
  await Promise.all([queues.crawl.close(), queues.linkcheck.close()]);
  await pool.end();
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
