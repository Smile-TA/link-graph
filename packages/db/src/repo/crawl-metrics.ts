/**
 * `crawl_metrics` — the per-crawl rollup analyse writes (step 4) and retention keeps
 * indefinitely (step 13). The columns beyond PRD §7's list arrived with
 * `005_analysis.sql`, which explains why each one exists.
 */
import type { Queryable } from "../pool.js";

/**
 * Why a crawl's orphan count is unknown (`007_drop_soft_orphan.sql`). Two different
 * facts with two different remedies, which a bare NULL cannot tell apart:
 *
 * - `no_truth_source` — the site has no inventory to take the set difference against
 *   (PRD §2, Undetectable). A content decision, or a site nobody can check.
 * - `sampled` — the crawl covered a ceiling rather than the whole site by policy
 *   (PRD §15), so the absence of an inbound link is evidence of nothing. Deliberate,
 *   and not a coverage failure.
 */
export const ORPHANS_UNKNOWN_REASONS = ["no_truth_source", "sampled"] as const;
export type OrphansUnknownReason = (typeof ORPHANS_UNKNOWN_REASONS)[number];

export interface CrawlMetricsInput {
  readonly crawlId: number;
  /**
   * `null` — not zero — when this crawl cannot answer the orphan question, in which
   * case `orphansUnknownReason` says why. A CHECK ties the two together in both
   * directions, so a NULL count is never unexplained and a reason never sits beside a
   * real number.
   */
  readonly orphans: number | null;
  readonly orphansUnknownReason: OrphansUnknownReason | null;
  readonly linked: number;
  readonly excluded: number;
  readonly notInTruthSource: number;
  readonly undetectable: number;
  /**
   * Pages with no path from the homepage **over the edges this crawl saw**. A superset
   * of the orphans on a full crawl. On a sampled one it stays a count rather than
   * becoming unknown — PRD §15 keeps structure checked on the sample — but it is then a
   * statement about the sampled graph, not about the site: a page can be unreachable
   * here only because the crawl never fetched the page that links to it.
   */
  readonly unreachable: number;
  /** Internal edges to a page of this crawl that did not serve. */
  readonly broken: number;
  /** Internal edges whose target was never fetched: unknown, not broken. */
  readonly internalUnresolved: number;
  /** Distinct external target URLs. */
  readonly external: number;
  /**
   * The N `links.is_boilerplate` was computed at (PRD §6). A display parameter since
   * the soft-orphan class was dropped — no page class depends on it — but still needed
   * to compare one crawl's edge kinds with the next one's.
   */
  readonly boilerplateThresholdPct: number;
}

const COLUMNS = `crawl_id AS "crawlId", orphans,
  orphans_unknown_reason AS "orphansUnknownReason", linked, excluded,
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
       (crawl_id, orphans, orphans_unknown_reason, linked, excluded,
        not_in_truth_source,
        undetectable, unreachable, broken, internal_unresolved, external,
        boilerplate_threshold_pct)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (crawl_id) DO UPDATE SET
       orphans = excluded.orphans,
       orphans_unknown_reason = excluded.orphans_unknown_reason,
       linked = excluded.linked,
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
      metrics.orphansUnknownReason,
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

export interface SiteCrawlMetrics {
  readonly siteId: number;
  readonly orphans: number | null;
  readonly orphansUnknownReason: OrphansUnknownReason | null;
  readonly broken: number;
  /** Internal edges whose target was never fetched: unknown, never broken. */
  readonly internalUnresolved: number;
  /** Distinct external target URLs. */
  readonly external: number;
  /** Pages in that crawl. */
  readonly pageCount: number;
}

/**
 * One row per site for its latest complete crawl's stored rollup (docs/notes.md item
 * 17) — the sites-list "at a glance" table. `DISTINCT ON` applies
 * `findLatestCompleteCrawl`'s own ordering (`crawls.ts`) across every site in one query
 * rather than 164 round trips, and joins straight to the already-computed
 * `crawl_metrics` row instead of re-deriving orphan/broken counts from `findings.ts`'s
 * per-row queries (which scan every link of the crawl — too expensive to run per site on
 * every home-page request).
 */
export async function listLatestCrawlMetricsPerSite(
  db: Queryable,
): Promise<SiteCrawlMetrics[]> {
  const { rows } = await db.query<SiteCrawlMetrics>(
    `SELECT DISTINCT ON (c.site_id) c.site_id AS "siteId", cm.orphans,
       cm.orphans_unknown_reason AS "orphansUnknownReason", cm.broken,
       cm.internal_unresolved AS "internalUnresolved", cm.external,
       (SELECT count(*)::int FROM pages p WHERE p.crawl_id = c.id) AS "pageCount"
     FROM crawls c
     JOIN crawl_metrics cm ON cm.crawl_id = c.id
     WHERE c.status = 'complete' AND c.env = 'prod'
     ORDER BY c.site_id, c.finished_at DESC NULLS LAST, c.id DESC`,
  );
  return rows;
}
