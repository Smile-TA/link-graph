export { databaseUrl } from "./config.js";
export { createPool, expectOneRow, withTransaction } from "./pool.js";
// Test scaffolding, exported because engineering guide §4.3 requires every service to
// have a test entry point that runs without any other service: packages/analyse needs a
// throwaway database, and a deep import into this package's src/ would be a seam nobody
// declared.
export { createTempDatabase } from "./testing/temp-database.js";
export type { TempDatabase } from "./testing/temp-database.js";
// Same reason, for the same consumer: `analyse.int.test.ts` asserts that a crawl of one
// page of integrity.com's ~2,000 is refused rather than reported as zero orphans, and
// these captures are the only real crawl output of a large site that exists before
// step 6.
export { CAPTURE_SITES, captureCrawlJson } from "./testing/captures.js";
export type { Capture, CaptureSite } from "./testing/captures.js";
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
  listSites,
  isInventory,
  CRAWLER_MODES,
  CRAWL_SCOPES,
  TRUTH_SOURCES,
} from "./repo/sites.js";
export type {
  CrawlerMode,
  CrawlScope,
  SiteInput,
  SiteRow,
  TruthSource,
} from "./repo/sites.js";
export {
  insertRegistryHealth,
  listRegistryHealth,
  listLatestRegistryHealth,
} from "./repo/registry-health.js";
export type { RegistryHealthInput } from "./repo/registry-health.js";
export {
  insertCrawl,
  findCrawl,
  findLatestCompleteCrawl,
  finishCrawl,
  reopenCrawl,
  countCrawlRows,
  findPreviousCompleteCrawl,
  listCompleteCrawlIds,
  pruneCrawlDetail,
  CRAWL_ENVS,
  CRAWL_STATUSES,
} from "./repo/crawls.js";
export type {
  CrawlEnv,
  CrawlInput,
  CrawlOutcome,
  CrawlRow,
  CrawlRowCounts,
  CrawlStatus,
} from "./repo/crawls.js";
export {
  addToFrontier,
  countFrontier,
  markFrontierFetched,
  nextFrontierUrl,
  recordFrontierFailure,
} from "./repo/frontier.js";
export type { FrontierCounts, FrontierEntry, FrontierRow } from "./repo/frontier.js";
export {
  insertPages,
  listPages,
  findPageByUrl,
  PAGE_CLASSES,
  PAGE_COLUMNS,
} from "./repo/pages.js";
export type { PageClass, PageInput, PageRow } from "./repo/pages.js";
export { insertLinks, listLinks, resolveLinkTargets } from "./repo/links.js";
export type { LinkInput, LinkRow } from "./repo/links.js";
export {
  upsertExternalUrl,
  upsertExternalUrls,
  findExternalUrl,
  listExternalUrlsDue,
  countExternalUrls,
} from "./repo/external-urls.js";
export type { ExternalUrlInput } from "./repo/external-urls.js";
export {
  upsertCrawlMetrics,
  findCrawlMetrics,
  ORPHANS_UNKNOWN_REASONS,
} from "./repo/crawl-metrics.js";
export type { CrawlMetricsInput, OrphansUnknownReason } from "./repo/crawl-metrics.js";
export {
  markBoilerplateLinks,
  countFetchedPages,
  countTruthSourcePages,
  computePageDepths,
  listPageAnalysisFacts,
  setPageClasses,
  countAnalysedLinks,
} from "./repo/analysis.js";
export type { LinkAnalysisCounts, PageAnalysisFact } from "./repo/analysis.js";
export {
  insertCrawlDiff,
  insertCrawlDiffs,
  listCrawlDiffs,
  listDiffEventsForSubjects,
} from "./repo/crawl-diffs.js";
export type { CrawlDiffInput, DiffEventRow } from "./repo/crawl-diffs.js";
export { listOrphanFindings, listBrokenLinkFindings } from "./repo/findings.js";
export type { BrokenLinkFinding, OrphanFinding } from "./repo/findings.js";
// Test scaffolding, exported for the reason `createTempDatabase` is (guide §4.3): the
// bucketing tests in packages/review and the report tests in packages/cli both build
// this row, and three builders for one nine-column row is three things to edit per
// column.
export { someFindingReview } from "./testing/reviews.js";
export { insertCompleteCrawl } from "./testing/crawls.js";
export {
  findFindingReview,
  listFindingReviews,
  upsertFindingReview,
  FINDING_KINDS,
  REVIEW_STATES,
} from "./repo/finding-reviews.js";
export type {
  FindingKind,
  FindingReviewInput,
  FindingReviewRow,
  ReviewState,
} from "./repo/finding-reviews.js";
