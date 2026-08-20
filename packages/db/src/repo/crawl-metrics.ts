/**
 * `crawl_metrics` — the per-crawl rollup analyse writes (step 4) and retention keeps
 * indefinitely (step 13). The columns beyond PRD §7's list arrived with
 * `005_analysis.sql`, which explains why each one exists.
 */
import type { Queryable } from "../pool.js";

export interface CrawlMetricsInput {
  readonly crawlId: number;
  /**
   * `null` — not zero — when the site has no truth source, because there is then no
   * inventory to difference against and the answer is unknown (PRD §2, Undetectable).
   * The two are null together, which a CHECK enforces.
   */
  readonly orphans: number | null;
  readonly softOrphans: number | null;
  readonly linked: number;
  readonly excluded: number;
  readonly notInTruthSource: number;
  readonly undetectable: number;
  /** Pages with no path from the homepage. A superset of the orphans. */
  readonly unreachable: number;
  /** Internal edges to a page of this crawl that did not serve. */
  readonly broken: number;
  /** Internal edges whose target was never fetched: unknown, not broken. */
  readonly internalUnresolved: number;
  /** Distinct external target URLs. */
  readonly external: number;
  /** The N `softOrphans` was computed at (PRD §6, §15). */
  readonly boilerplateThresholdPct: number;
}

const COLUMNS = `crawl_id AS "crawlId", orphans,
  soft_orphans AS "softOrphans", linked, excluded,
  not_in_truth_source AS "notInTruthSource", undetectable, unreachable, broken,
  internal_unresolved AS "internalUnresolved", external,
  boilerplate_threshold_pct AS "boilerplateThresholdPct"`;

/** Upsert, because re-running analyse on one crawl must replace its numbers. */
export async function upsertCrawlMetrics(
  db: Queryable,
  metrics: CrawlMetricsInput,
): Promise<void> {
  await db.query(
    `INSERT INTO crawl_metrics
       (crawl_id, orphans, soft_orphans, linked, excluded, not_in_truth_source,
        undetectable, unreachable, broken, internal_unresolved, external,
        boilerplate_threshold_pct)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (crawl_id) DO UPDATE SET
       orphans = excluded.orphans,
       soft_orphans = excluded.soft_orphans, linked = excluded.linked,
       excluded = excluded.excluded,
       not_in_truth_source = excluded.not_in_truth_source,
       undetectable = excluded.undetectable, unreachable = excluded.unreachable,
       broken = excluded.broken,
       internal_unresolved = excluded.internal_unresolved,
       external = excluded.external,
       boilerplate_threshold_pct = excluded.boilerplate_threshold_pct`,
    [
      metrics.crawlId,
      metrics.orphans,
      metrics.softOrphans,
      metrics.linked,
      metrics.excluded,
      metrics.notInTruthSource,
      metrics.undetectable,
      metrics.unreachable,
      metrics.broken,
      metrics.internalUnresolved,
      metrics.external,
      metrics.boilerplateThresholdPct,
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
