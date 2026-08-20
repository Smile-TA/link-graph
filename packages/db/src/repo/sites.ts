/**
 * `sites` — the registry row (PRD §3). Thin: no liveness logic, no alias derivation.
 *
 * Reads alias every column to camelCase in the SELECT rather than mapping rows in
 * TypeScript, so there is one place — the query — that knows the column names.
 */
import type { Queryable } from "../pool.js";

/**
 * `null` = not resolved yet; `'none'` = resolved, and there is none (PRD §2);
 * `'unreachable'` = the host never answered, so nothing was resolved either way.
 *
 * The fourth value arrived with step 5 and `006_truth_source.sql`, which explains why:
 * `agents.integrity.com` has no DNS and `integritymedicarehelpline.com` refuses
 * connections while both hold live pw-template configs (PRD §3.1), and filing those as
 * "this site has no inventory" hides a broken deployment behind a content finding.
 * `hasTruthSource` in packages/analyse tests for 'rest' or 'sitemap' positively, so a
 * value added here cannot be mistaken for an inventory.
 */
export const TRUTH_SOURCES = ["rest", "sitemap", "none", "unreachable"] as const;
export type TruthSource = (typeof TRUTH_SOURCES)[number];

/**
 * Whether a `truth_source` value is an inventory to take the orphan set difference
 * against. It lives beside the vocabulary because two callers need exactly this test —
 * `analyse`'s `hasTruthSource` and the fixture parser, which refuses an inventory size
 * on a site that has no inventory — and a predicate with two homes is how they drift.
 *
 * Written as a positive test of the two values that ARE an inventory, so that the next
 * value added to the list above is safe by default: the exclusion form would have
 * silently called `unreachable` an inventory and reported orphans for a site nobody
 * could reach.
 */
export function isInventory(truthSource: TruthSource | null): boolean {
  return truthSource === "rest" || truthSource === "sitemap";
}

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

/**
 * The registry row behind a crawl. `crawls.site_id` is the surrogate id, so this is
 * the lookup analyse needs: the alias set decides the homepage URL, and `truth_source`
 * decides whether the orphan question can be answered at all (PRD §2).
 */
export async function findSiteById(db: Queryable, id: number): Promise<SiteRow | null> {
  const { rows } = await db.query<SiteRow>(`SELECT ${COLUMNS} FROM sites WHERE id = $1`, [
    id,
  ]);
  return rows[0] ?? null;
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
