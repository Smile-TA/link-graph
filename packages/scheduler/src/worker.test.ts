import type { CrawlReport } from "@link-graph/cli";
import type { LinkcheckResult } from "@link-graph/linkcheck";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

const { runCrawlCommand } = vi.hoisted(() => ({ runCrawlCommand: vi.fn() }));
vi.mock("@link-graph/cli", () => ({ runCrawlCommand }));

const { checkExternalUrls } = vi.hoisted(() => ({ checkExternalUrls: vi.fn() }));
vi.mock("@link-graph/linkcheck", () => ({ checkExternalUrls }));

const { processCrawlJob, processLinkcheckJob } = await import("./worker.js");

const pool = {} as Pool;

describe("processCrawlJob", () => {
  it("enqueues a linkcheck job for the crawl it just produced", async () => {
    const report = { crawl: { crawlId: 42 } } as CrawlReport;
    runCrawlCommand.mockResolvedValueOnce(report);
    const add = vi.fn().mockResolvedValue(undefined);

    const result = await processCrawlJob(pool, { add }, {})({ siteId: "site-a" });

    expect(result).toBe(report);
    expect(runCrawlCommand).toHaveBeenCalledWith(
      pool,
      "site-a",
      expect.any(Function),
      {},
    );
    expect(add).toHaveBeenCalledWith("after-crawl", { crawlId: 42 });
  });

  it("never enqueues a linkcheck job when the crawl throws", async () => {
    runCrawlCommand.mockRejectedValueOnce(new Error("crawl failed"));
    const add = vi.fn().mockResolvedValue(undefined);

    await expect(
      processCrawlJob(pool, { add }, {})({ siteId: "site-a" }),
    ).rejects.toThrow("crawl failed");
    expect(add).not.toHaveBeenCalled();
  });
});

describe("processLinkcheckJob", () => {
  it("passes the crawl id and deps straight through", async () => {
    const linkcheckResult = { external: 3 } as unknown as LinkcheckResult;
    checkExternalUrls.mockResolvedValueOnce(linkcheckResult);
    const deps = { now: () => new Date(0), runner: { run: vi.fn() } };

    const result = await processLinkcheckJob(pool, deps)({ crawlId: 7 });

    expect(result).toBe(linkcheckResult);
    expect(checkExternalUrls).toHaveBeenCalledWith(pool, 7, deps);
  });
});
