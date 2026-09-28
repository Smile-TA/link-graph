import type { SiteRow } from "@link-graph/db";
import type { Queue } from "bullmq";
import type { CrawlJobData } from "./queues.js";

/**
 * PRD §8: "weekly full crawl per site", prod only in phase 1 — which is every row
 * `listSites` returns, since `env` is a property of a crawl, not a site (migration
 * `002_crawls.sql`), and phase 1 never writes `stage`. Sunday 03:00 (docs/notes.md
 * item 5 — originally Monday, moved earlier), off-peak and clear of any human's
 * workweek morning.
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
/**
 * Every site's next scheduled crawl time, read from BullMQ's own job schedulers rather
 * than computed from `WEEKLY_CRON` in isolation (docs/notes.md item 6's "next crawl"
 * column) — `upsertJobScheduler` keys each scheduler on the site id
 * (`scheduleWeeklyCrawls` above), so `getJobSchedulers` already returns exactly this
 * lookup in one round trip; the alternative of computing "next Sunday 03:00" in the web
 * package would silently drift from reality the day someone changes `WEEKLY_CRON` here
 * and forgets a second copy of the pattern over there.
 *
 * A disabled site has no scheduler (skipped by `scheduleWeeklyCrawls`) and so has no
 * entry in the returned map — read as "nothing scheduled", not as a zero or a past
 * date, which would misreport a site that was never due at all as overdue.
 */
export async function listNextCrawlTimes(
  queue: Pick<Queue<CrawlJobData>, "getJobSchedulers">,
): Promise<Map<string, Date>> {
  // `0, -1` is BullMQ's own "every scheduler" range, not a magic pair invented here —
  // matches `getJobSchedulers`'s own doc default.
  const schedulers = await queue.getJobSchedulers(0, -1);
  const next = new Map<string, Date>();
  for (const scheduler of schedulers) {
    if (scheduler.next !== undefined) next.set(scheduler.key, new Date(scheduler.next));
  }
  return next;
}

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
