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

/** Playwright is opt-in per site (PRD §5). Which fetcher, not how much to crawl. */
export const CRAWLER_MODES = ["http", "playwright"] as const;
export type CrawlerMode = (typeof CRAWLER_MODES)[number];

/**
 * How much of the site a crawl covers (PRD §15, `008_sample_scope.sql`).
 *
 * `sample` exists for templated sites: `agent.familyfirstlife.com` is 59,363 pages that
 * are one page with a per-agent substitution, and crawling it whole costs 16.5 hours at
 * the measured 1 req/s for nothing. It is a separate axis from `crawlerMode` because
 * that one is which fetcher, and a site can need both a real browser and a ceiling.
 *
 * **A sampled crawl cannot answer the orphan question**, since that is a set difference
 * against the *whole* truth source — `analyse` reports `orphans: null` with the reason
 * `sampled` rather than a zero (PRD §2, §15).
 */
export const CRAWL_SCOPES = ["full", "sample"] as const;
export type CrawlScope = (typeof CRAWL_SCOPES)[number];

export interface SiteInput {
  readonly siteId: string;
  readonly canonicalHost: string;
  readonly aliases: readonly string[];
  readonly stageHost: string | null;
  readonly enabled: boolean;
  readonly truthSource: TruthSource | null;
  readonly crawlerMode: CrawlerMode;
  readonly crawlScope: CrawlScope;
  /**
   * The page ceiling for a sampled crawl. Non-null exactly when `crawlScope` is
   * `sample`, which a CHECK enforces: `sample` with no ceiling is a full crawl wearing
   * the label, and a ceiling on a `full` site is a limit nothing enforces.
   */
  readonly sampleCeiling: number | null;
  /** Requests per second. */
  readonly rateLimit: number;
  readonly ignorePaths: readonly string[];
  /**
   * Substrings of an external link's URL that exclude it from checking and from the
   * external-links count on this site, wherever it is linked from (docs/notes.md item
   * 16) — a tracker pixel that 403s every bot, a share link that needs a session
   * cookie. Distinct from `ignorePaths`: that excludes whole *pages of this site* from
   * the orphan question; this excludes specific *link targets* from the linkcheck/
   * reporting path. `014_ignore_link_patterns.sql`.
   */
  readonly ignoreLinkPatterns: readonly string[];
  /**
   * Non-null when the latest liveness probe found this host redirecting to a
   * different host (PRD-adjacent: `docs/notes.md` item 1). Distinct from `enabled` —
   * see `013_redirect_alias.sql` — and re-derived on every `registry sync`, so it goes
   * back to `null` if the redirect disappears.
   */
  readonly redirectTargetHost: string | null;
}

export interface SiteRow extends SiteInput {
  readonly id: number;
}

const COLUMNS = `id, site_id AS "siteId", canonical_host AS "canonicalHost", aliases,
  stage_host AS "stageHost", enabled, truth_source AS "truthSource",
  crawler_mode AS "crawlerMode", crawl_scope AS "crawlScope",
  sample_ceiling AS "sampleCeiling", rate_limit AS "rateLimit",
  ignore_paths AS "ignorePaths", ignore_link_patterns AS "ignoreLinkPatterns",
  redirect_target_host AS "redirectTargetHost"`;

/**
 * Insert, or update in place when the registry slug already exists. Upsert rather
 * than insert because a site outlives its crawls: loading a second fixture for the
 * same site must reuse the row, not fail and not duplicate it.
 */
export async function upsertSite(db: Queryable, site: SiteInput): Promise<SiteRow> {
  const { rows } = await db.query<SiteRow>(
    `INSERT INTO sites (site_id, canonical_host, aliases, stage_host, enabled,
                        truth_source, crawler_mode, crawl_scope, sample_ceiling,
                        rate_limit, ignore_paths, ignore_link_patterns,
                        redirect_target_host)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (site_id) DO UPDATE SET
       canonical_host = excluded.canonical_host, aliases = excluded.aliases,
       stage_host = excluded.stage_host, enabled = excluded.enabled,
       truth_source = excluded.truth_source, crawler_mode = excluded.crawler_mode,
       crawl_scope = excluded.crawl_scope, sample_ceiling = excluded.sample_ceiling,
       rate_limit = excluded.rate_limit, ignore_paths = excluded.ignore_paths,
       ignore_link_patterns = excluded.ignore_link_patterns,
       redirect_target_host = excluded.redirect_target_host
     RETURNING ${COLUMNS}`,
    [
      site.siteId,
      site.canonicalHost,
      site.aliases,
      site.stageHost,
      site.enabled,
      site.truthSource,
      site.crawlerMode,
      site.crawlScope,
      site.sampleCeiling,
      site.rateLimit,
      site.ignorePaths,
      site.ignoreLinkPatterns,
      site.redirectTargetHost,
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

/**
 * Every registry row, `site_id` order. Added for step 9's coverage-drift report
 * (PRD §3.1), which has to compare the whole registry against its liveness history —
 * a one-site lookup cannot answer "what is deployed but unmonitored across the estate".
 */
export async function listSites(db: Queryable): Promise<SiteRow[]> {
  const { rows } = await db.query<SiteRow>(
    `SELECT ${COLUMNS} FROM sites ORDER BY site_id`,
  );
  return rows;
}
