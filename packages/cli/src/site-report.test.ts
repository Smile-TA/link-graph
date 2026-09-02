/**
 * What `link-graph report <site-id>` prints. Pure: a stored crawl's numbers in, text
 * out, with the clock injected.
 *
 * The rule every case here is about is PRD §7.1 rule 1 — **a review never changes a
 * measured number**. The measured total is printed first and identically whatever the
 * reviews say, the three bucket counts sit beside it, and no state of the review table
 * can turn "4 orphans" into "no orphans" or into 0.
 */
import { describe, expect, it } from "vitest";
import {
  bucketFindings,
  brokenLinkFinding,
  evidenceDigest,
  orphanFinding,
} from "@link-graph/review";
import { someFindingReview } from "@link-graph/db";
import type { FindingReviewRow, OrphanFinding } from "@link-graph/db";
import { formatSiteReport, siteReportProblem, type SiteReport } from "./site-report.js";
import { someMetrics } from "./testing/report.js";

const NOW = new Date("2026-09-02T09:08:15.000Z");
const REVIEWED_AT = new Date("2026-08-20T09:08:15.000Z");

/** 403bplan.net's real crawl: 13 pages, 240 links, 9 linked, 4 orphans. */
const ORPHAN_PAGES: OrphanFinding[] = [
  "/newsletter-signup/",
  "/newsletters/",
  "/plan-participant/online-access/",
  "/test-pay-button/",
].map((path) => ({
  urlNormalized: `https://403bplan.net${path}`,
  class: "orphan",
  postType: null,
  statusCode: 200,
}));

/**
 * `/contact-us/` serving a 404 — 15 edges from **13 distinct pages**, measured on the
 * fixture. The two numbers differ and both are real: blast radius is distinct pages
 * (PRD §2), `crawl_metrics.broken` is edges.
 */
const BROKEN = {
  urlNormalized: "https://403bplan.net/contact-us/",
  statusCode: 404,
  blastRadius: 13,
};

const digestOf = (page: OrphanFinding) => evidenceDigest(orphanFinding(page).evidence);

const review = (
  page: OrphanFinding,
  over: Partial<FindingReviewRow> = {},
): FindingReviewRow =>
  someFindingReview({
    subject: page.urlNormalized,
    note: "a leftover test page",
    evidenceDigest: digestOf(page),
    reviewedAt: REVIEWED_AT,
    ...over,
  });

function build(
  reviews: readonly FindingReviewRow[] = [],
  over: Partial<SiteReport> = {},
): SiteReport {
  const bySubject = new Map(reviews.map((row) => [row.subject, row]));
  return {
    siteId: "403bplan-net",
    canonicalHost: "403bplan.net",
    truthSource: "sitemap",
    crawl: {
      finishedAt: REVIEWED_AT,
      pages: 13,
      links: 240,
      truthSourceUrls: 13,
      wasThrottled: false,
    },
    metrics: someMetrics(),
    orphans: bucketFindings(ORPHAN_PAGES.map(orphanFinding), bySubject),
    brokenLinks: bucketFindings([], bySubject),
    ...over,
  };
}

describe("formatSiteReport", () => {
  /**
   * The whole thing, line for line — the same treatment `report.test.ts` gives the crawl
   * report, and for the same reason: it pins each number to the column it is printed in,
   * which is what catches two fields swapped rather than one field missing.
   */
  it("prints the whole report of a site nobody has reviewed yet", () => {
    expect(formatSiteReport(build(), NOW)).toBe(
      [
        "Site           403bplan-net  403bplan.net",
        "Crawl          #1 — 13 page(s) of a 13-URL inventory, 240 link(s)",
        "Finished       2026-08-20T09:08:15.000Z, 13 day(s) ago",
        "Pages          9 linked, 4 orphan, 0 excluded, 0 not in truth source, 0 undetectable",
        "Links          0 broken internal edge(s), 17 internal unresolved, 23 external",
        "Orphans        4 — 4 new, 0 changed since review, 0 reviewed",
        "Broken links   0 target(s) — 0 new, 0 changed since review, 0 reviewed",
        "",
        "Orphans — in the truth source, published, indexable, and nothing on this site links to them (4):",
        "",
        "    #  status  URL",
        "  new (4)",
        "    1     200  https://403bplan.net/newsletter-signup/",
        "    2     200  https://403bplan.net/newsletters/",
        "    3     200  https://403bplan.net/plan-participant/online-access/",
        "    4     200  https://403bplan.net/test-pay-button/",
        "  changed since review (0)",
        "    (none)",
        "  reviewed (0)",
        "    (none)",
        "",
        "Note: crawl #1's stored numbers, re-read rather than re-measured. Whether its inventory",
        "      was short of the site is computed per run and stored nowhere (PRD §15), so a crawl",
        "      that exited 3 because a truth source went unread is re-read here as an exit 0. Run",
        "      `link-graph crawl 403bplan-net` for that verdict.",
      ].join("\n"),
    );
  });

  /**
   * The step's first §1 test, at the level a person reads: review every orphan on the
   * site and the report still says there are four of them. "no orphans" or a 0 here
   * would be a suppressed finding that is indistinguishable from an absent one.
   */
  it("still counts every orphan when every one of them has been reviewed", () => {
    const text = formatSiteReport(build(ORPHAN_PAGES.map((page) => review(page))), NOW);

    expect(text).toContain(
      "Orphans        4 — 0 new, 0 changed since review, 4 reviewed " +
        "(4 intentional, 0 acknowledged)",
    );
    expect(text).not.toMatch(/no orphans/i);
    expect(text).not.toContain("Orphans        0");
    // The table is still there, with all four rows in it and numbered to the total.
    expect(text).toContain("  reviewed (4)");
    expect(text).toContain("    4     200  https://403bplan.net/test-pay-button/");
    expect(text).toContain("  new (0)");
  });

  /**
   * The row numbers run continuously across the three sections, so the last one is the
   * measured total — which is PRD §7.1 rule 1 put in front of the reader rather than
   * three lists they have to add up. Numbering per section instead would leave two rows
   * called #1.
   */
  it("numbers the rows across the sections, not within them", () => {
    const [first, second] = ORPHAN_PAGES;
    if (first === undefined || second === undefined) throw new Error("no orphans");
    const text = formatSiteReport(build([review(first), review(second)]), NOW);
    // Two new (#1, #2) followed by the two reviewed ones as #3 and #4.
    expect(text).toContain(
      "    1     200  https://403bplan.net/plan-participant/online-access/",
    );
    expect(text).toContain("    2     200  https://403bplan.net/test-pay-button/");
    expect(text).toContain("    3     200  https://403bplan.net/newsletter-signup/");
    expect(text).toContain("    4     200  https://403bplan.net/newsletters/");
  });

  /** Rule 3: how much of the backlog is deliberate versus outstanding. */
  it("splits the reviewed count by what the reviews claim", () => {
    const [first, second] = ORPHAN_PAGES;
    if (first === undefined || second === undefined) throw new Error("no orphans");
    const text = formatSiteReport(
      build([review(first), review(second, { state: "acknowledged", id: 2 })]),
      NOW,
    );
    expect(text).toContain("2 reviewed (1 intentional, 1 acknowledged)");
  });

  /** Rule 5, and the age §7.1 requires beside every review. */
  it("prints a review's claim, its author and its age under the finding", () => {
    const [first] = ORPHAN_PAGES;
    if (first === undefined) throw new Error("no orphans");
    const text = formatSiteReport(build([review(first)]), NOW);
    expect(text).toContain(
      "               intentional, judged 13 day(s) ago by smile: a leftover test page",
    );
  });

  it("ranks a finding whose evidence has moved as changed, with its stale review", () => {
    const [first] = ORPHAN_PAGES;
    if (first === undefined) throw new Error("no orphans");
    const stale = review(first, {
      evidenceDigest: digestOf({ ...first, statusCode: 404 }),
    });
    const text = formatSiteReport(build([stale]), NOW);

    expect(text).toContain(
      "Orphans        4 — 3 new, 1 changed since review, 0 reviewed",
    );
    expect(text).toContain("  changed since review (1)");
    expect(text).toContain(
      "               the evidence has moved since it was judged intentional 13 day(s)",
    );
    // That a `changed` finding counts towards neither state is `bucket.test.ts`'s
    // ("does not count a review whose evidence has moved"); asserting the absence of a
    // clause this fixture never prints would only look like coverage.
  });

  /**
   * PRD §2's Undetectable, re-read from a stored crawl: the reason in the count's place,
   * never a zero, and no table — a table of orphans under an unknown count would be the
   * count and the list disagreeing in print.
   */
  it("prints the reason rather than a zero when the orphan count is unknown", () => {
    const text = formatSiteReport(
      build([], {
        metrics: someMetrics({
          orphans: null,
          orphansUnknownReason: "sampled",
          linked: 9,
          undetectable: 4,
        }),
        orphans: [],
      }),
      NOW,
    );
    expect(text).toContain("Orphans        unknown — sampled:");
    expect(text).toContain("page ceiling");
    expect(text).not.toMatch(/Orphans\s+0/);
    expect(text).not.toContain("new (0)");
  });

  /**
   * Measured 2026-08-25 on integrity-2024.staging02: every page carries `noindex`, so
   * every page is Excluded and the orphan question is asked of nothing. "0 orphans"
   * there is true and reads as a clean bill of health.
   */
  it("says when a zero means the question was asked of nothing", () => {
    const text = formatSiteReport(
      build([], {
        metrics: someMetrics({ orphans: 0, linked: 0, excluded: 13, unreachable: 13 }),
        orphans: [],
      }),
      NOW,
    );
    expect(text).toContain("none could be");
    expect(text).toContain("13 page(s) are excluded");
  });

  /**
   * A throttled crawl missed pages, and a page it never fetched is an inbound link it
   * never saw — so the orphan list it produced is a ceiling. The crawl command says so
   * on its own row; a re-read that dropped it would print an inflated list as a count.
   */
  it("says when the crawl it is re-reading was throttled", () => {
    const text = formatSiteReport(
      build([], { crawl: { ...build().crawl, wasThrottled: true } }),
      NOW,
    );
    expect(text).toContain("Throttled      the host blocked this crawl at least once");
    expect(text).toContain("ceiling, not a count");
    // And not said on the ordinary run, where it would be noise.
    expect(formatSiteReport(build(), NOW)).not.toContain("Throttled");
  });

  it("prints broken internal links by blast radius, split the same three ways", () => {
    const text = formatSiteReport(
      build([], {
        metrics: someMetrics({ broken: 15 }),
        brokenLinks: bucketFindings([brokenLinkFinding(BROKEN)], new Map()),
      }),
      NOW,
    );
    expect(text).toContain(
      "Broken links   1 target(s) — 1 new, 0 changed since review, 0 reviewed",
    );
    // Blast radius is pages and `broken` is edges, so the two are labelled apart.
    expect(text).toContain("15 broken internal edge(s)");
    expect(text).toContain("    #  status  pages  URL");
    expect(text).toContain("    1     404     13  https://403bplan.net/contact-us/");
  });
});

describe("siteReportProblem", () => {
  it("passes a report whose count and list agree", () => {
    expect(siteReportProblem(build())).toBeNull();
  });

  /**
   * The stored path is the one where this is reachable: `pages.class` and the metrics
   * row are two rows written by one `analyse` transaction, and re-reading them separately
   * is where a crawl analysed by two different runs would show up.
   */
  it("refuses a report whose orphan count and orphan list disagree", () => {
    const problem = siteReportProblem(
      build([], { metrics: someMetrics({ orphans: 7 }) }),
    );
    expect(problem).toMatch(/counts 7 orphan\(s\) and lists 4/);
  });

  /** The page rows and the class counts are two reads on this path, so they can differ. */
  it("refuses a report whose class counts do not account for its page rows", () => {
    const problem = siteReportProblem(
      build([], { crawl: { ...build().crawl, pages: 14 } }),
    );
    expect(problem).toMatch(/account for 13 page\(s\) and the crawl has 14/);
  });

  /**
   * The edge count and the target list are two different queries on this path, so one
   * being zero while the other is not means one of them is wrong.
   */
  it("refuses broken edges with no targets, and targets with no edges", () => {
    const withTarget = build([], {
      metrics: someMetrics({ broken: 0 }),
      brokenLinks: bucketFindings([brokenLinkFinding(BROKEN)], new Map()),
    });
    expect(siteReportProblem(withTarget)).toMatch(
      /counts 0 broken internal edge\(s\) and lists 1 broken target\(s\)/,
    );
    expect(
      siteReportProblem(build([], { metrics: someMetrics({ broken: 15 }) })),
    ).toMatch(/counts 15 broken internal edge\(s\) and lists 0/);
  });

  /**
   * Every page linking to a broken target needs an edge to do it with, so the blast
   * radii cannot sum past the edge count. This is the edges-vs-distinct-pages confusion
   * itself, caught rather than printed.
   */
  it("refuses blast radii that sum past the broken edge count", () => {
    const problem = siteReportProblem(
      build([], {
        // 13 pages link to it, over 12 broken edges: impossible.
        metrics: someMetrics({ broken: 12 }),
        brokenLinks: bucketFindings([brokenLinkFinding(BROKEN)], new Map()),
      }),
    );
    expect(problem).toMatch(
      /linked from 13 page\(s\) in total, over 12 broken edge\(s\)/,
    );
  });

  it("refuses a list of orphans under an unknown count", () => {
    const problem = siteReportProblem(
      build([], {
        metrics: someMetrics({ orphans: null, orphansUnknownReason: "no_truth_source" }),
      }),
    );
    expect(problem).toMatch(/unknown/);
  });
});
