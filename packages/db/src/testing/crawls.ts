/**
 * One complete crawl row, dated and finished — the shape every step-13 test needs just
 * to exist as "a previous crawl" or "a later crawl", without repeating `insertCrawl`'s
 * full field list at every call site.
 */
import { finishCrawl, insertCrawl, type CrawlInput, type CrawlRow } from "../repo/crawls.js";
import { insertPages, type PageInput } from "../repo/pages.js";
import type { Queryable } from "../pool.js";

export async function insertCompleteCrawl(
  db: Queryable,
  siteId: number,
  finishedAt: Date,
  options: { readonly over?: Partial<CrawlInput>; readonly pages?: readonly PageInput[] } = {},
): Promise<CrawlRow> {
  const crawl = await insertCrawl(db, {
    siteId,
    env: "prod",
    startedAt: finishedAt,
    finishedAt: null,
    status: "running",
    deployedTag: null,
    registrySha: null,
    pagesSeen: 0,
    wasThrottled: false,
    truthSourceUrls: null,
    truthSourceRestUrls: null,
    truthSourceSitemapUrls: null,
    taxonomies: [],
    ...options.over,
  });
  if (options.pages !== undefined && options.pages.length > 0) {
    await insertPages(db, crawl.id, options.pages);
  }
  await finishCrawl(db, crawl.id, {
    status: "complete",
    finishedAt,
    pagesSeen: options.pages?.length ?? 0,
    wasThrottled: false,
  });
  return crawl;
}
