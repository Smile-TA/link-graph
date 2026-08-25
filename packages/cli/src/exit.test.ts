import { describe, expect, it } from "vitest";
import { PartialCrawlError } from "@link-graph/crawl";
import type { CrawlMetricsInput } from "@link-graph/db";
import { EXIT, exitCodeForFailure, exitCodeForReport, UsageError } from "./exit.js";
import type { CrawlReport } from "./report.js";
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
