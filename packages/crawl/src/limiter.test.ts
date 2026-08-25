/**
 * The two halves of PRD §5.1's measurement: one host is paced, and hosts do not wait
 * for each other.
 *
 * Asserted as overlap between recorded intervals rather than as a total elapsed time,
 * because a wall-clock threshold on a loaded CI box is the test that fails once a month
 * for no reason (engineering guide §4.4).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHostLimiter, type HostLimiter } from "./limiter.js";

interface Interval {
  readonly host: string;
  readonly start: number;
  readonly end: number;
}

let limiter: HostLimiter | null = null;
afterEach(async () => {
  await limiter?.stop();
  limiter = null;
});

/** A task that occupies its slot long enough for an overlap to be observable. */
function timedTask(host: string, log: Interval[], ms: number) {
  return async () => {
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, ms));
    log.push({ host, start, end: Date.now() });
  };
}

const overlaps = (a: Interval, b: Interval): boolean =>
  a.start < b.end && b.start < a.end;

describe("createHostLimiter", () => {
  it("runs one request at a time per host, spaced by the site's rate", async () => {
    limiter = createHostLimiter();
    // ~16.7 req/s, so the gap is 60ms. The production value is 1, which would make this
    // test three seconds long to prove the same thing.
    const queue = limiter.forHost("403bplan.net", 1000 / 60);
    const log: Interval[] = [];
    const started = Date.now();
    await Promise.all(
      [0, 1, 2].map(() => queue.schedule(timedTask("403bplan.net", log, 5))),
    );
    expect(log).toHaveLength(3);
    for (let i = 1; i < log.length; i++) {
      const previous = log[i - 1];
      const current = log[i];
      if (previous === undefined || current === undefined) throw new Error("missing");
      expect(overlaps(previous, current)).toBe(false);
    }
    // Three requests at a 60ms gap cannot finish in less than two gaps. At the crawler's
    // default 1 req/s this is the difference between an hour-long crawl and an hour-long
    // ban.
    expect(Date.now() - started).toBeGreaterThanOrEqual(115);
  });

  it("does not make one host wait for another", async () => {
    limiter = createHostLimiter();
    const log: Interval[] = [];
    // 5 req/s: a 200ms gap, so if the two hosts shared a queue the second task could not
    // start until the first was long finished.
    await Promise.all([
      limiter.forHost("403bplan.net", 5).schedule(timedTask("403bplan.net", log, 30)),
      limiter.forHost("lionstreet.com", 5).schedule(timedTask("lionstreet.com", log, 30)),
    ]);
    expect(log).toHaveLength(2);
    const [first, second] = log;
    if (first === undefined || second === undefined) throw new Error("missing");
    expect(overlaps(first, second)).toBe(true);
  });

  it("keeps the queue after a task throws, rather than deadlocking the crawl", async () => {
    limiter = createHostLimiter();
    const queue = limiter.forHost("403bplan.net", 100);
    await expect(
      queue.schedule(() => Promise.reject(new Error("404 handling"))),
    ).rejects.toThrow("404 handling");
    await expect(queue.schedule(() => Promise.resolve("next"))).resolves.toBe("next");
  });

  it("gives one host one queue however often it is asked for", async () => {
    limiter = createHostLimiter();
    await expect(
      limiter.forHost("403bplan.net", 1000).schedule(() => Promise.resolve(42)),
    ).resolves.toBe(42);
    // A second `forHost` must not make a second queue, or two crawls of one host would
    // each get the full rate and together double it — straight into Wordfence.
    const log: Interval[] = [];
    await Promise.all([
      limiter.forHost("403bplan.net", 20).schedule(timedTask("403bplan.net", log, 10)),
      limiter.forHost("403bplan.net", 20).schedule(timedTask("403bplan.net", log, 10)),
    ]);
    const [first, second] = log;
    if (first === undefined || second === undefined) throw new Error("missing");
    expect(overlaps(first, second)).toBe(false);
  });
});
