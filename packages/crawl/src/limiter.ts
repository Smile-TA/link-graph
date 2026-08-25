/**
 * Per-host rate limiting (PRD §5.1).
 *
 * Measured on whyaim.com 2026-08-18: Wordfence returns 503 at ~8 req/s sustained and
 * bans the source IP for an hour, and **the block is per-IP and per-host**. Both halves
 * of that sentence are in this file: one queue per host at one request at a time, and
 * nothing shared between hosts, so sites crawl concurrently while each of them stays at
 * its own configured rate.
 *
 * `bottleneck` rather than a hand-rolled queue (PRD §5.0): `minTime` plus
 * `maxConcurrent: 1` is exactly the shape needed, and its queue survives a task that
 * throws — a limiter that leaked its slot on an error would deadlock a crawl on the
 * first 404.
 */
import Bottleneck from "bottleneck";

/** One host's queue. Acquired once per crawl, so the rate is stated once. */
export interface HostQueue {
  /** Run `task` when this host's queue allows it. */
  schedule<T>(task: () => Promise<T>): Promise<T>;
}

export interface HostLimiter {
  /**
   * The queue for one host, at `requestsPerSecond` — `sites.rate_limit`, in the unit
   * the column is in. The first caller for a host fixes the rate: a host has one
   * `rate_limit`, and re-tuning a live queue underneath the requests already in it
   * would make the effective rate depend on arrival order.
   */
  forHost(host: string, requestsPerSecond: number): HostQueue;
  /** Releases the timers, so a finished crawl does not hold the process open. */
  stop(): Promise<void>;
}

export function createHostLimiter(): HostLimiter {
  const limiters = new Map<string, Bottleneck>();

  return {
    forHost(host: string, requestsPerSecond: number): HostQueue {
      let limiter = limiters.get(host);
      if (limiter === undefined) {
        limiter = new Bottleneck({
          minTime: 1000 / requestsPerSecond,
          maxConcurrent: 1,
        });
        limiters.set(host, limiter);
      }
      const queue = limiter;
      return { schedule: (task) => queue.schedule(task) };
    },
    async stop(): Promise<void> {
      // `disconnect` clears the interval bottleneck keeps for its queue; without it a
      // finished crawl leaves the event loop alive and vitest hangs on the handle.
      await Promise.all([...limiters.values()].map((l) => l.disconnect()));
      limiters.clear();
    },
  };
}
