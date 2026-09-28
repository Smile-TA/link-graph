import { describe, expect, it } from "vitest";
import type { SiteRow } from "@link-graph/db";
import { crawlVerdict } from "./verdict.js";

const site = (overrides: Partial<SiteRow> = {}): SiteRow => ({
  id: 1,
  siteId: "403bplan-net",
  canonicalHost: "403bplan.net",
  aliases: ["403bplan.net"],
  stageHost: null,
  enabled: true,
  truthSource: "sitemap",
  crawlerMode: "http",
  crawlScope: "full",
  sampleCeiling: null,
  rateLimit: 1,
  ignorePaths: [],
  redirectTargetHost: null,
  ...overrides,
});

describe("crawlVerdict", () => {
  it("is complete when the frontier is empty", () => {
    expect(crawlVerdict(site(), { stoppedBecause: null, pending: 0, pages: 13 })).toEqual(
      {
        status: "complete",
        stoppedBecause: null,
      },
    );
  });

  it("is partial when the loop stopped, whatever the counts say", () => {
    // The Wordfence case: 5 of 13 pages, and the 5 are real. They are still not a site.
    expect(
      crawlVerdict(site(), {
        stoppedBecause: "throttled: 503, retry-after 3600s",
        pending: 8,
        pages: 5,
      }),
    ).toMatchObject({ status: "partial", stoppedBecause: /503/ as unknown as string });
  });

  it("is partial when work is left and nothing said why", () => {
    // Unreachable through the loop as written, which is the point: if it ever becomes
    // reachable, it must not come out as a finished crawl.
    const verdict = crawlVerdict(site(), { stoppedBecause: null, pending: 4, pages: 9 });
    expect(verdict.status).toBe("partial");
    expect(verdict.stoppedBecause).toMatch(/bug in the loop/);
  });

  it("is partial when the crawl wrote no pages, even with an empty frontier", () => {
    // A crawl whose seeding died leaves a `running` row and an empty frontier; a resume
    // would find no work and, without this rule, call it complete with zero pages —
    // engineering guide §1's opening example.
    const verdict = crawlVerdict(site(), { stoppedBecause: null, pending: 0, pages: 0 });
    expect(verdict.status).toBe("partial");
    expect(verdict.stoppedBecause).toMatch(/no pages at all/);
  });

  it("calls a sampled crawl complete once it reaches its ceiling", () => {
    // PRD §15: the shortfall is deliberate, so it is not a failure. `analyse` reports
    // orphans as null with the reason `sampled`, which is the honest statement.
    const sampled = site({ crawlScope: "sample", sampleCeiling: 5 });
    expect(crawlVerdict(sampled, { stoppedBecause: null, pending: 8, pages: 5 })).toEqual(
      {
        status: "complete",
        stoppedBecause: null,
      },
    );
  });

  it("does not call a sampled crawl complete short of its ceiling", () => {
    const sampled = site({ crawlScope: "sample", sampleCeiling: 5 });
    expect(
      crawlVerdict(sampled, { stoppedBecause: null, pending: 8, pages: 4 }).status,
    ).toBe("partial");
  });

  it("never lets a full-scope site inherit the sample exemption", () => {
    const full = site({ sampleCeiling: null });
    expect(
      crawlVerdict(full, { stoppedBecause: null, pending: 1, pages: 12 }).status,
    ).toBe("partial");
  });
});
