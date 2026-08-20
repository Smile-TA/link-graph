/**
 * `sites` — the registry row (PRD §3). Thin: no liveness logic, no alias derivation.
 *
 * Reads alias every column to camelCase in the SELECT rather than mapping rows in
 * TypeScript, so there is one place — the query — that knows the column names.
 */
import type { Queryable } from "../pool.js";

/** `null` = not resolved yet; `'none'` = resolved, and there is none (PRD §2). */
export const TRUTH_SOURCES = ["rest", "sitemap", "none"] as const;
export type TruthSource = (typeof TRUTH_SOURCES)[number];

/** Playwright is opt-in per site (PRD §5). */
export const CRAWLER_MODES = ["http", "playwright"] as const;
export type CrawlerMode = (typeof CRAWLER_MODES)[number];

export interface SiteInput {
  readonly siteId: string;
  readonly canonicalHost: string;
  readonly aliases: readonly string[];
  readonly stageHost: string | null;
  readonly enabled: boolean;
  readonly truthSource: TruthSource | null;
  readonly crawlerMode: CrawlerMode;
  /** Requests per second. */
  readonly rateLimit: number;
  readonly ignorePaths: readonly string[];
}

export interface SiteRow extends SiteInput {
  readonly id: number;
}

const COLUMNS = `id, site_id AS "siteId", canonical_host AS "canonicalHost", aliases,
  stage_host AS "stageHost", enabled, truth_source AS "truthSource",
  crawler_mode AS "crawlerMode", rate_limit AS "rateLimit",
  ignore_paths AS "ignorePaths"`;

/**
 * Insert, or update in place when the registry slug already exists. Upsert rather
 * than insert because a site outlives its crawls: loading a second fixture for the
 * same site must reuse the row, not fail and not duplicate it.
 */
export async function upsertSite(db: Queryable, site: SiteInput): Promise<SiteRow> {
  const { rows } = await db.query<SiteRow>(
    `INSERT INTO sites (site_id, canonical_host, aliases, stage_host, enabled,
                        truth_source, crawler_mode, rate_limit, ignore_paths)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (site_id) DO UPDATE SET
       canonical_host = excluded.canonical_host, aliases = excluded.aliases,
       stage_host = excluded.stage_host, enabled = excluded.enabled,
       truth_source = excluded.truth_source, crawler_mode = excluded.crawler_mode,
       rate_limit = excluded.rate_limit, ignore_paths = excluded.ignore_paths
     RETURNING ${COLUMNS}`,
    [
      site.siteId,
      site.canonicalHost,
      site.aliases,
      site.stageHost,
      site.enabled,
      site.truthSource,
      site.crawlerMode,
      site.rateLimit,
      site.ignorePaths,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`upsertSite wrote no row for ${site.siteId}`);
  return row;
}

export async function findSiteBySlug(
  db: Queryable,
  siteId: string,
): Promise<SiteRow | null> {
  const { rows } = await db.query<SiteRow>(
    `SELECT ${COLUMNS} FROM sites WHERE site_id = $1`,
    [siteId],
  );
  return rows[0] ?? null;
}
