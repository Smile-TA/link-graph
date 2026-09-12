import type { CrawlReport } from "@link-graph/cli";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueues, redisConnection } from "./queues.js";
import { createWorkers, type Workers } from "./worker.js";

const { runCrawlCommand } = vi.hoisted(() => ({ runCrawlCommand: vi.fn() }));
vi.mock("@link-graph/cli", () => ({ runCrawlCommand }));

// This test is about the real Redis/BullMQ wiring between the two queues, not about
// `checkExternalUrls`'s own I/O (that seam has its own integration tests in
// packages/linkcheck) — faked here so the linkcheck job can complete without a real
// Postgres pool or a real lychee binary.
const { checkExternalUrls } = vi.hoisted(() => ({
  checkExternalUrls: vi.fn().mockResolvedValue({}),
}));
vi.mock("@link-graph/linkcheck", () => ({ checkExternalUrls }));

const connection = redisConnection(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const pool = {} as Pool;

let workers: Workers | undefined;

afterEach(async () => {
  await workers?.crawl.close();
  await workers?.linkcheck.close();
  workers = undefined;
});

describe("createWorkers, against a real Redis", () => {
  it("a crawl job's completion is what puts a linkcheck job on the queue", async () => {
    const queues = createQueues(connection);
    try {
      const report = { crawl: { crawlId: 99 } } as CrawlReport;
      runCrawlCommand.mockResolvedValueOnce(report);

      workers = createWorkers(pool, connection, queues.linkcheck, {
        crawl: {},
        linkcheck: { runner: { run: vi.fn() }, now: () => new Date(0) },
      });

      const linkcheckJobData = new Promise<unknown>((resolve) => {
        workers?.linkcheck.on("completed", (job) => resolve(job.data));
      });

      await queues.crawl.add("weekly", { siteId: "some-site" });

      await expect(linkcheckJobData).resolves.toEqual({ crawlId: 99 });
      expect(runCrawlCommand).toHaveBeenCalledWith(
        pool,
        "some-site",
        expect.any(Function),
        {},
      );
    } finally {
      await queues.crawl.close();
      await queues.linkcheck.close();
    }
  }, 10000);
});
