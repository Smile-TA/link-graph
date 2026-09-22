/**
 * A `CrawlReport` to vary one field of. Shared by `report.test.ts` and `exit.test.ts`,
 * which had a copy each: the model carries twelve metric columns and two nested blocks,
 * and two builders in one directory is two things to edit every time a column is added.
 *
 * The crawl half is 403bplan.net's real output — 13 pages, 240 links, 9 linked and 4
 * orphan — so a test that changes nothing is asserting against a table that exists. The
 * three inventory counts are deliberately **all different**, which that site's are not:
 * equal numbers let two of the three fields swap without a single assertion moving. 14 =
 * 13 REST ∪ 11 sitemap is a real shape (integrity.com's two sources disagree in both
 * directions), and 13 page rows for a 14-URL inventory is the per-URL shortfall
 * `coverage.ts` describes — an inventory URL that redirected onto another.
 */
import type { CrawlMetricsInput } from "@link-graph/db";
import type { CrawlReport } from "../report.js";

export const someMetrics = (
  over: Partial<CrawlMetricsInput> = {},
): CrawlMetricsInput => ({
  crawlId: 1,
  orphans: 4,
  orphansUnknownReason: null,
  linked: 9,
  excluded: 0,
  notInTruthSource: 0,
  undetectable: 0,
  unreachable: 4,
  broken: 0,
  internalUnresolved: 17,
  external: 23,
  boilerplateThresholdPct: 60,
  ...over,
});

export const THE_ORPHANS = [
  { urlNormalized: "https://403bplan.net/newsletter-signup/", statusCode: 200 },
  { urlNormalized: "https://403bplan.net/newsletters/", statusCode: 200 },
  {
    urlNormalized: "https://403bplan.net/plan-participant/online-access/",
    statusCode: 200,
  },
  { urlNormalized: "https://403bplan.net/test-pay-button/", statusCode: 200 },
];

export const someReport = (over: Partial<CrawlReport> = {}): CrawlReport => ({
  siteId: "403bplan-net",
  canonicalHost: "403bplan.net",
  env: "prod",
  truth: {
    kind: "rest",
    registryWas: null,
    inventory: 14,
    rest: 13,
    sitemap: 11,
    requests: 5,
    findings: [],
  },
  crawl: {
    crawlId: 1,
    pages: 13,
    links: 240,
    aliasHops: 0,
    wasThrottled: false,
    pending: 0,
  },
  metrics: someMetrics(),
  orphans: THE_ORPHANS,
  ...over,
});
