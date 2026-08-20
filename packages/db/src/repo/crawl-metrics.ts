/**
 * `crawl_metrics` — the per-crawl rollup analyse writes (step 4) and retention keeps
 * indefinitely (step 13). Only the counters PRD §7 names exist so far.
 */
import type { Queryable } from "../pool.js";

export interface CrawlMetricsInput {
  readonly crawlId: number;
  readonly orphans: number;
  readonly softOrphans: number;
  readonly excluded: number;
  readonly broken: number;
  readonly external: number;
}

const COLUMNS = `crawl_id AS "crawlId", orphans, soft_orphans AS "softOrphans",
  excluded, broken, external`;

/** Upsert, because re-running analyse on one crawl must replace its numbers. */
export async function upsertCrawlMetrics(
  db: Queryable,
  metrics: CrawlMetricsInput,
): Promise<void> {
  await db.query(
    `INSERT INTO crawl_metrics
       (crawl_id, orphans, soft_orphans, excluded, broken, external)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (crawl_id) DO UPDATE SET
       orphans = excluded.orphans, soft_orphans = excluded.soft_orphans,
       excluded = excluded.excluded, broken = excluded.broken,
       external = excluded.external`,
    [
      metrics.crawlId,
      metrics.orphans,
      metrics.softOrphans,
      metrics.excluded,
      metrics.broken,
      metrics.external,
    ],
  );
}

export async function findCrawlMetrics(
  db: Queryable,
  crawlId: number,
): Promise<CrawlMetricsInput | null> {
  const { rows } = await db.query<CrawlMetricsInput>(
    `SELECT ${COLUMNS} FROM crawl_metrics WHERE crawl_id = $1`,
    [crawlId],
  );
  return rows[0] ?? null;
}
