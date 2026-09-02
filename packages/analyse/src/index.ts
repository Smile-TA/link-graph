export { analyse } from "./analyse.js";
export type { AnalyseOptions } from "./analyse.js";
export { classifyPage, hasTruthSource, orphansUnknownReason } from "./classify.js";
export {
  truthSourceCoverageProblem,
  DEFAULT_MIN_TRUTH_SOURCE_COVERAGE_PCT,
} from "./coverage.js";
export type { PageClass, PageFacts, SiteRules } from "./classify.js";
// Test scaffolding, exported for the reason `@link-graph/db` exports `createTempDatabase`
// and `captureCrawlJson` (engineering guide §4.3): another package's integration tier
// needs a real crawl of a whole site, and a deep import into this package's src/ would be
// a seam nobody declared. `packages/cli`'s review tests need exactly this one — 13 real
// pages of 403bplan.net whose orphan answer was derived by hand — because the smaller
// captures in `db` are one page of a large site, which `analyse` refuses.
//
// Only the two names a consumer uses: this package's own tests import the rest from
// `./testing/403bplan.js` directly, and a public export with no caller is API surface
// nobody asked for.
export { build403bplanCrawl } from "./testing/403bplan.js";
export type { FixtureCrawlJson } from "./testing/403bplan.js";
