import { describe, expect, it } from "vitest";
import { PartialCrawlError } from "@link-graph/crawl";
import type { CrawlMetricsInput } from "@link-graph/db";
import { EXIT, exitCodeForFailure, exitCodeForReport, UsageError } from "./exit.js";
import type { TruthFindingKind } from "@link-graph/truth";
import { inventoryIsProvablyIncomplete, type CrawlReport } from "./report.js";
import { someMetrics, someReport } from "./testing/report.js";

const reportWith = (metrics: Partial<CrawlMetricsInput>): CrawlReport =>
  someReport({ metrics: someMetrics(metrics), orphans: [] });

/**
 * The numbers themselves, not `EXIT.x` compared with `EXIT.x`. Every other assertion in
 * this suite reads the constant it is checking, so swapping two of them — `usage` and
 * `failed`, say, which a CI job uses to tell "bad invocation" from "the estate refused" —
 * would leave the suite green. These four values are a published interface.
 */
describe("EXIT", () => {
  it("is the documented table", () => {
    expect(EXIT).toEqual({ ok: 0, usage: 1, failed: 2, undetectable: 3 });
  });
});

describe("exitCodeForReport", () => {
  it("succeeds when the orphan question was answered", () => {
    expect(exitCodeForReport(reportWith({ orphans: 4 }))).toBe(0);
    // Finding orphans is the command working, not the command failing.
    expect(exitCodeForReport(reportWith({ orphans: 0 }))).toBe(EXIT.ok);
  });

  /**
   * The contract this command exists to keep: a cron or a CI job that reads only the
   * exit code must never conclude "fine" from a run that found nothing because it could
   * not look. Both unknown reasons are non-zero — `sampled` is deliberate rather than a
   * failure, but it is still not an answer.
   */
  it("is non-zero when the orphan count is unknown, whichever reason", () => {
    for (const reason of ["no_truth_source", "sampled"] as const) {
      const code = exitCodeForReport(
        reportWith({ orphans: null, orphansUnknownReason: reason }),
      );
      expect(code, reason).toBe(EXIT.undetectable);
      expect(code, reason).not.toBe(0);
    }
  });
});

/**
 * Decided 2026-08-25 (PRD §15). A resolution that lost one of its two sources still
 * produced an inventory, and the orphan set difference is against **that** — so the run
 * would otherwise exit 0 under a code documented as "the table printed is the whole
 * site". Measured shape: REST answers 403 (`rest-unusable`), the sitemap answers, and on
 * integrity.com the difference is taken against 96 URLs instead of 124 with the other 28
 * never mentioned — up to 28 real orphans unreported by a run calling itself clean.
 *
 * The split is by what each finding *means*, not by severity in the abstract: a source
 * that could not be read makes the inventory provably short, while sources that were
 * both read and merely disagree do not.
 */
describe("inventoryIsProvablyIncomplete", () => {
  const incomplete: TruthFindingKind[] = [
    "rest-unusable",
    "rest-incomplete",
    "rest-total-mismatch",
    "sitemap-incomplete",
  ];
  const complete: TruthFindingKind[] = [
    // A site with nothing published is not a failure to read REST (step 5).
    "rest-empty",
    // The content was read; the status was merely recorded. `wp-sitemap-posts-page-30`
    // answers 404 with 1,363 valid URLs, and content decides (step 5).
    "sitemap-degraded",
    // Both sources were read and disagree. That is `sitemap-invisible` arithmetic, an
    // orthogonal axis to the orphan question, not a hole in the inventory.
    "sitemap-invisible",
    "rest-missing",
    // Bookkeeping about URLs the inventory should not have listed anyway.
    "dropped-url",
    "duplicate-url",
  ];

  for (const kind of incomplete) {
    it(`treats ${kind} as a provably short inventory`, () => {
      expect(inventoryIsProvablyIncomplete([{ kind, detail: "d" }])).toBe(true);
    });
  }

  for (const kind of complete) {
    it(`does not treat ${kind} as a short inventory`, () => {
      expect(inventoryIsProvablyIncomplete([{ kind, detail: "d" }])).toBe(false);
    });
  }

  it("is false with no findings at all, and true if any one of many qualifies", () => {
    expect(inventoryIsProvablyIncomplete([])).toBe(false);
    expect(
      inventoryIsProvablyIncomplete([
        { kind: "duplicate-url", detail: "d" },
        { kind: "rest-unusable", detail: "HTTP 403" },
        { kind: "dropped-url", detail: "d" },
      ]),
    ).toBe(true);
  });
});

describe("exitCodeForReport with a degraded resolution", () => {
  const withFindings = (kinds: TruthFindingKind[], over = {}): CrawlReport =>
    someReport({
      metrics: someMetrics({ orphans: 4, ...over }),
      orphans: [],
      truth: {
        ...someReport().truth,
        findings: kinds.map((kind) => ({ kind, detail: "d" })),
      },
    });

  it("is 3 when a source was lost, even though a count was produced", () => {
    const code = exitCodeForReport(withFindings(["rest-unusable"]));
    expect(code).toBe(EXIT.undetectable);
    expect(code).not.toBe(EXIT.ok);
  });

  it("stays 0 when both sources were read and merely disagree", () => {
    expect(exitCodeForReport(withFindings(["sitemap-invisible", "rest-missing"]))).toBe(
      EXIT.ok,
    );
  });

  /** An unknown count already exits 3; a lost source must not downgrade that to 0. */
  it("stays 3 when the count is unknown and a source was also lost", () => {
    expect(
      exitCodeForReport(
        withFindings(["rest-incomplete"], {
          orphans: null,
          orphansUnknownReason: "sampled",
        }),
      ),
    ).toBe(EXIT.undetectable);
  });
});

describe("exitCodeForFailure", () => {
  it("separates a usage error from a run that failed", () => {
    expect(exitCodeForFailure(new UsageError("no such site"))).toBe(EXIT.usage);
    expect(exitCodeForFailure(new Error("anything else"))).toBe(EXIT.failed);
  });

  it("gives a partial crawl a failing code", () => {
    const partial = new PartialCrawlError({
      crawlId: 7,
      status: "partial",
      pages: 6,
      links: 100,
      aliasHops: 0,
      wasThrottled: true,
      retryAfterSeconds: 3600,
      pending: 7,
      stoppedBecause: "throttled: HTTP 503",
    });
    expect(exitCodeForFailure(partial)).toBe(EXIT.failed);
    expect(exitCodeForFailure(partial)).not.toBe(EXIT.ok);
  });

  /** A thrown non-Error still has to end the process non-zero. */
  it("fails on anything that is not an Error at all", () => {
    expect(exitCodeForFailure("boom")).toBe(EXIT.failed);
  });
});
