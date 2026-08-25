export { analyse } from "./analyse.js";
export type { AnalyseOptions } from "./analyse.js";
export { classifyPage, hasTruthSource, orphansUnknownReason } from "./classify.js";
export {
  truthSourceCoverageProblem,
  DEFAULT_MIN_TRUTH_SOURCE_COVERAGE_PCT,
} from "./coverage.js";
export type { PageClass, PageFacts, SiteRules } from "./classify.js";
