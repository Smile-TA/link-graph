export { crawl, resumeCrawl, PartialCrawlError } from "./crawl.js";
export type { CrawlDeps, CrawlResult } from "./crawl.js";
export type { CrawlSeeds } from "./seeds.js";
export { createHttpFetcher } from "./fetcher.js";
export { createPlaywrightFetcher } from "./playwright-fetcher.js";
export type { CrawlFetcher, FetchResponse, FetchResult } from "./fetcher.js";
export { createHostLimiter } from "./limiter.js";
export type { HostLimiter } from "./limiter.js";
// Test scaffolding, exported for the reason `packages/db`'s index gives for exporting
// `createTempDatabase`: engineering guide §4.3 requires every service to have a test
// entry point that runs without any other service, and a deep import into this
// package's src/ would be a seam nobody declared. The first consumer is step 7's CLI,
// whose integration test has to crawl a whole site without touching the estate —
// Wordfence bans the source IP for an hour on the first 503 (PRD §5.1).
export { startFixtureServer } from "./testing/fixture-server.js";
export type {
  FixtureHandler,
  FixtureResponse,
  FixtureServer,
} from "./testing/fixture-server.js";
export { serve403bplan, HOST, HTML } from "./testing/403bplan.js";
