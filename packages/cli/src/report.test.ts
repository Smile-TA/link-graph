import { describe, expect, it } from "vitest";
import { formatReport, reportProblem, type CrawlReport } from "./report.js";
import {
  someMetrics as metrics,
  someReport as report,
  THE_ORPHANS as ORPHANS,
} from "./testing/report.js";

/** The crawl block, restated per case because `pending` is what varies. */
const crawl = (over: Partial<CrawlReport["crawl"]> = {}): CrawlReport["crawl"] => ({
  crawlId: 1,
  pages: 13,
  links: 240,
  aliasHops: 0,
  wasThrottled: false,
  pending: 0,
  ...over,
});

/** A site whose truth source could not be read at all: no inventory, no counts. */
const noInventory = (kind: "none" | "unreachable"): CrawlReport["truth"] => ({
  kind,
  registryWas: null,
  inventory: null,
  rest: null,
  sitemap: null,
  requests: 4,
  findings: [],
});

const unknownOrphans = metrics({
  orphans: null,
  orphansUnknownReason: "no_truth_source",
  linked: 1,
  undetectable: 8,
  unreachable: 0,
});

describe("formatReport", () => {
  /**
   * The whole report, line for line. Every other test here varies one thing; this one
   * pins each number to the column it is printed in, which is what catches two fields
   * swapped rather than one field missing.
   */
  it("prints the real 403bplan.net report", () => {
    expect(formatReport(report())).toBe(
      [
        "Site           403bplan-net  403bplan.net",
        "Truth source   rest — 14 URL(s) (REST 13, sitemap 11) in 5 request(s), registry updated from unresolved",
        "Crawl          #1 complete — 13 page(s) of a 14-URL inventory, 240 link(s)",
        "Pages          9 linked, 4 orphan, 0 excluded, 0 not in truth source, 0 undetectable",
        "Links          0 broken, 17 internal unresolved, 23 external (boilerplate N = 60%)",
        "Unreachable    4 page(s) with no path from the homepage over the edges this crawl saw",
        "Orphans        4 — listed below",
        "",
        "Orphans — in the truth source, published, indexable, and nothing on this site links to them (4):",
        "",
        "    #  status  URL",
        "    1     200  https://403bplan.net/newsletter-signup/",
        "    2     200  https://403bplan.net/newsletters/",
        "    3     200  https://403bplan.net/plan-participant/online-access/",
        "    4     200  https://403bplan.net/test-pay-button/",
      ].join("\n"),
    );
  });

  it("keeps the inventory total and the two source counts in their own columns", () => {
    // integrity.com's real figures: 124 published pages in REST, 96 of them in the
    // sitemap, and one URL the sitemap lists that REST does not — so the union is 125
    // and no two of the three numbers are equal. That is the only shape in which a
    // swapped or conflated field cannot hide.
    const text = formatReport(
      report({
        truth: {
          kind: "rest",
          registryWas: "rest",
          inventory: 125,
          rest: 124,
          sitemap: 96,
          requests: 34,
          findings: [],
        },
      }),
    );
    expect(text).toContain(
      "Truth source   rest — 125 URL(s) (REST 124, sitemap 96) in 34 request(s)",
    );
  });

  it("says which source was never read, rather than calling it zero", () => {
    const text = formatReport(
      report({
        truth: {
          kind: "sitemap",
          registryWas: "sitemap",
          inventory: 96,
          rest: null,
          sitemap: 96,
          requests: 7,
          findings: [],
        },
      }),
    );
    expect(text).toContain("(REST not read, sitemap 96)");
  });

  /**
   * Engineering guide §1, and the whole reason this command exists: a site with no
   * inventory has a coverage gap, and a coverage gap printed as a number is the failure
   * that reads as good news. **Both** places the count appears are checked — the summary
   * row and the class breakdown — because a zero in either is the same lie.
   */
  it("prints the reason and never a number when the orphan count is unknown", () => {
    const text = formatReport(
      report({
        truth: noInventory("none"),
        metrics: unknownOrphans,
        orphans: [],
        crawl: crawl({ crawlId: 2, pages: 9, links: 200 }),
      }),
    );
    expect(text).toMatch(/Orphans\s+unknown/);
    expect(text).toContain("no_truth_source");
    expect(text).toMatch(/coverage gap/i);
    // The class breakdown carries no orphan number either.
    expect(text).toContain("? orphan,");
    expect(text).not.toMatch(/\d+ orphan,/);
  });

  /**
   * `orphans_unknown_reason` has one value for two facts with different remedies, and
   * `006_truth_source.sql` exists because they are different: a dead host is a
   * registry-health finding, not a content decision.
   */
  it("tells a dead host apart from a site that has no inventory", () => {
    // Whitespace collapsed: these sentences are wrapped to the value column, and what
    // is under test is which sentence was chosen, not where it broke. The exact
    // wrapping is pinned by the line-for-line test above.
    const of = (kind: "none" | "unreachable") =>
      formatReport(
        report({
          truth: noInventory(kind),
          metrics: unknownOrphans,
          orphans: [],
          crawl: crawl({ pages: 9, links: 200 }),
        }),
      ).replace(/\s+/g, " ");
    expect(of("unreachable")).toMatch(/nothing answered on this host's truth-source/);
    expect(of("unreachable")).not.toMatch(/the remedy is a truth source/);
    expect(of("none")).toMatch(/the remedy is a truth source/);
    expect(of("none")).not.toMatch(/nothing answered/);
  });

  it("distinguishes a sample from a site with nothing to compare against", () => {
    const text = formatReport(
      report({
        metrics: metrics({ orphans: null, orphansUnknownReason: "sampled" }),
        orphans: [],
        crawl: crawl({ pages: 5, links: 116, pending: 8 }),
      }),
    );
    expect(text).toContain("sampled");
    expect(text).toMatch(/policy|deliberate/i);
    expect(text).not.toContain("no_truth_source");
    // A sampled crawl is `complete` and still never fetched most of the inventory. The
    // top line has to say so, or "complete" reads as "the whole site".
    expect(text).toContain("8 queued URL(s) never fetched");
  });

  it("says so in words when a site has no orphans, rather than printing an empty table", () => {
    const text = formatReport(
      report({ metrics: metrics({ orphans: 0, linked: 13 }), orphans: [] }),
    );
    expect(text).toMatch(/Orphans\s+none/);
    expect(text).not.toContain("listed below");
  });

  /** Step 5 computes nine degradations and nothing stores them; this is their reader. */
  it("prints the truth-source findings, and what they cost", () => {
    const text = formatReport(
      report({
        truth: {
          kind: "sitemap",
          registryWas: "rest",
          inventory: 96,
          rest: null,
          sitemap: 96,
          requests: 7,
          findings: [
            {
              kind: "rest-unusable",
              detail: "https://integrity.com/wp-json/wp/v2/types: HTTP 403",
            },
          ],
        },
      }),
    );
    expect(text).toContain("rest-unusable");
    expect(text).toContain("https://integrity.com/wp-json/wp/v2/types: HTTP 403");
    // The consequence, not just the fact: a source that could not be read is an
    // inventory that may be smaller than the site, and the orphan table is a set
    // difference against that inventory.
    expect(text).toMatch(/only as complete as the inventory/);
    expect(text).toContain("registry updated from rest");
  });

  it("says when a throttled crawl produced these numbers, and only then", () => {
    expect(formatReport(report({ crawl: crawl({ wasThrottled: true }) }))).toMatch(
      /throttled by the host/,
    );
    expect(formatReport(report())).not.toMatch(/throttl/i);
  });

  it("prints a dash for an orphan the crawl never fetched", () => {
    // An `in_truth_source` page with no fetch still classifies `orphan` (reported by
    // step 5), so the status cell has to distinguish 200 from "nobody looked".
    const text = formatReport(
      report({
        metrics: metrics({ orphans: 1, linked: 12 }),
        orphans: [
          { urlNormalized: "https://403bplan.net/newsletters/", statusCode: null },
        ],
      }),
    );
    expect(text).toContain("    1       -  https://403bplan.net/newsletters/");
  });
});

/**
 * The printed line and the exit code have to agree. Exit 3 for a provably short
 * inventory (PRD §15, decided 2026-08-25) would otherwise sit under a table headed
 * "none — every URL assessed has at least one inbound internal link", which is the
 * clean bill of health the code is refusing to give.
 */
describe("formatReport when a source was lost", () => {
  const lostRest = (over = {}): CrawlReport =>
    report({
      metrics: metrics({ orphans: 0, ...over }),
      orphans: [],
      truth: {
        ...report().truth,
        rest: null,
        findings: [{ kind: "rest-unusable", detail: "HTTP 403" }],
      },
    });

  it("does not call zero orphans a clean site", () => {
    const out = formatReport(lostRest());
    expect(out).not.toMatch(/Orphans\s+none —/);
    expect(out).toMatch(/Orphans\s+0 of an inventory that is short/);
    // The reader is told which source is missing, not merely that one is.
    expect(out).toContain("rest-unusable");
  });

  it("says the same of a non-zero count, which is also only of what was read", () => {
    const out = formatReport(lostRest({ orphans: 4 }));
    expect(out).toMatch(/Orphans\s+4 of an inventory that is short/);
    expect(out).not.toMatch(/Orphans\s+4 — listed below/);
  });

  it("leaves an intact inventory's wording alone", () => {
    const intact = report({
      metrics: metrics({ orphans: 0 }),
      orphans: [],
      truth: {
        ...report().truth,
        findings: [{ kind: "sitemap-invisible", detail: "28 page(s)" }],
      },
    });
    expect(formatReport(intact)).toMatch(/Orphans\s+none —/);
  });
});

/**
 * Measured 2026-08-25 against `integrity-2024.staging02.imgwebhost.com`: every page of
 * that site carries `<meta name='robots' content='noindex, nofollow'>` — verified on the
 * homepage and `/about-us/`. Under PRD §2 every page is then Excluded, including the
 * crawl root, since Excluded outranks the crawl-root rule. So `orphans` is 0 with
 * `linked` also 0, and the old wording said "every URL in this site's truth source has
 * at least one inbound internal link" — which is false: no URL was assessed at all. A
 * zero that reads as good news, which is the one thing this report may not do.
 */
describe("formatReport when no page of the inventory was assessed", () => {
  const allExcluded = report({
    metrics: metrics({ orphans: 0, linked: 0, excluded: 13, undetectable: 0 }),
    orphans: [],
  });

  it("does not claim every URL is linked when none was even asked about", () => {
    const out = formatReport(allExcluded);
    expect(out).not.toMatch(/at least one inbound internal link/);
    expect(out).toMatch(/Orphans\s+none found, and none could be/);
    expect(out).toContain("13");
  });

  it("still says none-and-clean when pages really were assessed", () => {
    const assessed = report({
      metrics: metrics({ orphans: 0, linked: 9, excluded: 4 }),
      orphans: [],
    });
    const out = formatReport(assessed);
    expect(out).toMatch(/at least one inbound internal link/);
    // "every URL in the truth source" would be false the moment anything is excluded,
    // and since 010 that is every taxonomy and author archive — so the number of pages
    // the question was not asked of is part of the same sentence, and asserted here
    // rather than merely printed.
    // Whitespace collapsed: the row wraps at 88 columns, so the phrase spans two lines.
    expect(out.replace(/\s+/g, " ")).toContain("(4 excluded page(s) were not assessed)");
  });

  it("says nothing about exclusions when there were none", () => {
    const clean = report({
      metrics: metrics({ orphans: 0, linked: 13, excluded: 0 }),
      orphans: [],
    });
    expect(formatReport(clean)).not.toContain("excluded page(s)");
  });
});

describe("reportProblem", () => {
  it("passes a report whose table and count agree", () => {
    expect(reportProblem(report())).toBeNull();
  });

  /**
   * The table is what a reader acts on and the count is what a dashboard reads. If they
   * disagree, one of them is wrong and there is no way to tell which — so neither is
   * printed.
   */
  it("refuses a table that is shorter than the count it claims", () => {
    expect(reportProblem(report({ orphans: ORPHANS.slice(1) }))).toMatch(
      /counts 4 orphan\(s\) and lists 3/,
    );
  });

  it("refuses orphan rows on a crawl that cannot count orphans", () => {
    const problem = reportProblem(
      report({ metrics: metrics({ orphans: null, orphansUnknownReason: "sampled" }) }),
    );
    expect(problem).toMatch(/sampled/);
    expect(problem).toMatch(/4 page\(s\) are classified orphan/);
  });

  /** Every page of the crawl carries exactly one class, so the five counts must sum. */
  it("refuses class counts that do not account for every page crawled", () => {
    expect(reportProblem(report({ metrics: metrics({ linked: 8 }) }))).toMatch(
      /account for 12 page\(s\) and the crawl fetched 13/,
    );
  });

  /**
   * The two independent statements about whether this site can be checked at all: what
   * the resolution found, and what the metrics row says. "No truth source" beside a REST
   * inventory of 13 URLs means the `sites.truth_source` write did not happen.
   */
  it("refuses a crawl called sourceless by a resolution that found a source", () => {
    const problem = reportProblem(
      report({
        metrics: metrics({
          orphans: null,
          orphansUnknownReason: "no_truth_source",
          linked: 13,
        }),
        orphans: [],
      }),
    );
    expect(problem).toMatch(/the resolution found one \(rest, 14 URL\(s\)\)/);
  });
});
