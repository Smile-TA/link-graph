export { databaseUrl } from "./config.js";
export { createPool, withTransaction } from "./pool.js";
// Test scaffolding, exported because engineering guide §4.3 requires every service to
// have a test entry point that runs without any other service: packages/analyse needs a
// throwaway database, and a deep import into this package's src/ would be a seam nobody
// declared.
export { createTempDatabase } from "./testing/temp-database.js";
export type { TempDatabase } from "./testing/temp-database.js";
export type { Queryable } from "./pool.js";
export { runMigrations, MIGRATIONS_DIR } from "./migrate.js";
export type { MigrateOptions } from "./migrate.js";
export { parseCrawlFixture, loadFixture, loadFixtureFile } from "./fixture.js";
export type {
  CrawlFixture,
  FixtureCrawl,
  FixtureLink,
  LoadedFixture,
  LoadFixtureDeps,
} from "./fixture.js";
export {
  upsertSite,
  findSiteById,
  findSiteBySlug,
  CRAWLER_MODES,
  TRUTH_SOURCES,
} from "./repo/sites.js";
export type { CrawlerMode, SiteInput, SiteRow, TruthSource } from "./repo/sites.js";
export { insertRegistryHealth, listRegistryHealth } from "./repo/registry-health.js";
export type { RegistryHealthInput } from "./repo/registry-health.js";
export { insertCrawl, findCrawl, CRAWL_ENVS, CRAWL_STATUSES } from "./repo/crawls.js";
export type { CrawlEnv, CrawlInput, CrawlRow, CrawlStatus } from "./repo/crawls.js";
export {
  insertPages,
  listPages,
  findPageByUrl,
  PAGE_CLASSES,
  PAGE_COLUMNS,
} from "./repo/pages.js";
export type { PageClass, PageInput, PageRow } from "./repo/pages.js";
export { insertLinks, listLinks } from "./repo/links.js";
export type { LinkInput, LinkRow } from "./repo/links.js";
export { upsertExternalUrl, findExternalUrl } from "./repo/external-urls.js";
export type { ExternalUrlInput } from "./repo/external-urls.js";
export { upsertCrawlMetrics, findCrawlMetrics } from "./repo/crawl-metrics.js";
export type { CrawlMetricsInput } from "./repo/crawl-metrics.js";
export {
  markBoilerplateLinks,
  countFetchedPages,
  computePageDepths,
  listPageAnalysisFacts,
  setPageClasses,
  countAnalysedLinks,
} from "./repo/analysis.js";
export type { LinkAnalysisCounts, PageAnalysisFact } from "./repo/analysis.js";
export { insertCrawlDiff, listCrawlDiffs } from "./repo/crawl-diffs.js";
export type { CrawlDiffInput } from "./repo/crawl-diffs.js";
