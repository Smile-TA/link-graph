/**
 * Which fetcher a site's `crawler_mode` names (PRD §5).
 *
 * Its own file, and a map rather than an `if`, so that `satisfies` makes a mode added
 * to the vocabulary a compile error here instead of a site silently crawled by
 * whichever branch the `else` happened to be.
 */
import type { CrawlerMode } from "@link-graph/db";
import { createHttpFetcher, type CrawlFetcher } from "./fetcher.js";
import { createPlaywrightFetcher } from "./playwright-fetcher.js";

export const FETCHERS = {
  http: createHttpFetcher,
  playwright: createPlaywrightFetcher,
} satisfies Record<CrawlerMode, () => CrawlFetcher>;
