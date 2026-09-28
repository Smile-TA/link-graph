import type { SiteRow } from "@link-graph/db";
import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import type { CrawlJobData } from "./queues.js";
import { listNextCrawlTimes, scheduleWeeklyCrawls } from "./schedule.js";

function site(siteId: string, enabled: boolean): SiteRow {
  return {
    id: 1,
    siteId,
    canonicalHost: `${siteId}.example.com`,
    aliases: [],
    stageHost: null,
    enabled,
    truthSource: null,
    crawlerMode: "http",
    crawlScope: "full",
    sampleCeiling: null,
    rateLimit: 1,
    ignorePaths: [],
    redirectTargetHost: null,
  };
}

function fakeQueue(): {
  upsertJobScheduler: ReturnType<typeof vi.fn>;
  queue: Queue<CrawlJobData>;
} {
  const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
  return {
    upsertJobScheduler,
    queue: { upsertJobScheduler } as unknown as Queue<CrawlJobData>,
  };
}

describe("scheduleWeeklyCrawls", () => {
  it("registers one weekly job scheduler per enabled site, keyed on its site id", async () => {
    const { upsertJobScheduler, queue } = fakeQueue();
    const result = await scheduleWeeklyCrawls(queue, [site("a", true), site("b", true)]);

    expect(result).toEqual({ scheduled: ["a", "b"], skipped: [] });
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      "a",
      { pattern: "0 3 * * 0" },
      { data: { siteId: "a" } },
    );
    expect(upsertJobScheduler).toHaveBeenCalledTimes(2);
  });

  it("skips a disabled site rather than scheduling it to fail weekly", async () => {
    const { upsertJobScheduler, queue } = fakeQueue();
    const result = await scheduleWeeklyCrawls(queue, [site("dead", false)]);

    expect(result).toEqual({ scheduled: [], skipped: ["dead"] });
    expect(upsertJobScheduler).not.toHaveBeenCalled();
  });

  it("re-running with the same sites replaces rather than duplicates the schedule", async () => {
    const { upsertJobScheduler, queue } = fakeQueue();
    await scheduleWeeklyCrawls(queue, [site("a", true)]);
    await scheduleWeeklyCrawls(queue, [site("a", true)]);

    // `upsertJobScheduler` keys on its first argument, which this asserts is the same
    // site id both times rather than something that would grow a second scheduler.
    expect(upsertJobScheduler).toHaveBeenNthCalledWith(
      1,
      "a",
      { pattern: "0 3 * * 0" },
      { data: { siteId: "a" } },
    );
    expect(upsertJobScheduler).toHaveBeenNthCalledWith(
      2,
      "a",
      { pattern: "0 3 * * 0" },
      { data: { siteId: "a" } },
    );
  });
});

describe("listNextCrawlTimes", () => {
  it("maps each scheduler's key to its next-run time", async () => {
    const getJobSchedulers = vi.fn().mockResolvedValue([
      { key: "a", name: "a", next: 1791082800000 },
      { key: "b", name: "b", next: 1791687600000 },
    ]);
    const queue = { getJobSchedulers } as unknown as Pick<
      Queue<CrawlJobData>,
      "getJobSchedulers"
    >;

    const next = await listNextCrawlTimes(queue);

    expect(getJobSchedulers).toHaveBeenCalledWith(0, -1);
    expect(next.get("a")).toEqual(new Date(1791082800000));
    expect(next.get("b")).toEqual(new Date(1791687600000));
    expect(next.size).toBe(2);
  });

  it("omits a scheduler with no next run rather than defaulting it to a date", async () => {
    const getJobSchedulers = vi
      .fn()
      .mockResolvedValue([{ key: "no-next", name: "no-next" }]);
    const queue = { getJobSchedulers } as unknown as Pick<
      Queue<CrawlJobData>,
      "getJobSchedulers"
    >;

    const next = await listNextCrawlTimes(queue);

    expect(next.has("no-next")).toBe(false);
  });

  it("returns an empty map when nothing is scheduled", async () => {
    const getJobSchedulers = vi.fn().mockResolvedValue([]);
    const queue = { getJobSchedulers } as unknown as Pick<
      Queue<CrawlJobData>,
      "getJobSchedulers"
    >;

    expect((await listNextCrawlTimes(queue)).size).toBe(0);
  });
});
