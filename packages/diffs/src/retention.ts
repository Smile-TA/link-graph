/**
 * Which crawls' link-level detail to drop (PRD §7: "12 crawls per site, then roll up to
 * `crawl_metrics` kept indefinitely").
 *
 * Pure: the caller reads the site's complete crawl ids newest-first and this just slices
 * the tail. `crawl_metrics` and `crawl_diffs` reference `crawls`, not `pages`/`links`, so
 * pruning a crawl's page rows (which cascades to its link rows, `002_crawls.sql`) leaves
 * both intact — the crawl still exists, only its row-level detail is gone.
 */
export function crawlsToPrune(
  completeCrawlIdsNewestFirst: readonly number[],
  keep = 12,
): number[] {
  return completeCrawlIdsNewestFirst.slice(keep);
}
