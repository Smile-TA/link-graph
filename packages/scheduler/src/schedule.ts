import type { SiteRow } from "@link-graph/db";
import type { Queue } from "bullmq";
import type { CrawlJobData } from "./queues.js";

/**
 * PRD §8: "weekly full crawl per site", prod only in phase 1 — which is every row
 * `listSites` returns, since `env` is a property of a crawl, not a site (migration
 * `002_crawls.sql`), and phase 1 never writes `stage`. Monday 03:00, off-peak and clear
 * of any human's Monday morning.
 */
const WEEKLY_CRON = "0 3 * * 0";

/**
 * Registers one BullMQ job scheduler per enabled site, keyed on the site id. Idempotent
 * by construction: `upsertJobScheduler` replaces the scheduler for a given key rather
 * than adding a second one, so calling this again with the same sites changes nothing —
 * which is what lets it run once at worker startup instead of needing its own cron
 * trigger. That is the whole of "Jenkins does nothing" (PRD §8): the schedule lives in
 * Redis, owned by this process, not in an external CI job.
 *
 * A disabled site (PRD §3.1: not currently served) is skipped rather than scheduled and
 * left to fail weekly — the liveness probe (step 9) is what turns it back on.
 */
export async function scheduleWeeklyCrawls(
  queue: Queue<CrawlJobData>,
  sites: readonly SiteRow[],
): Promise<{ scheduled: string[]; skipped: string[] }> {
  const scheduled: string[] = [];
  const skipped: string[] = [];
  for (const site of sites) {
    if (!site.enabled) {
      skipped.push(site.siteId);
      continue;
    }
    await queue.upsertJobScheduler(
      site.siteId,
      { pattern: WEEKLY_CRON },
      { data: { siteId: site.siteId } },
    );
    scheduled.push(site.siteId);
  }
  return { scheduled, skipped };
}
