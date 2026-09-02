/** `crawls` — one crawl of one site (PRD §7). */
import { expectOneRow, type Queryable } from "../pool.js";

/**
 * A crawl that ended early is `partial`, never `complete` (guide §1). Declared as a
 * value with the union derived from it, so the fixture parser can validate against
 * the same list rather than repeating it.
 */
export const CRAWL_STATUSES = ["running", "complete", "partial"] as const;
export type CrawlStatus = (typeof CRAWL_STATUSES)[number];

/** Phase 1 crawls prod only (PRD §8); stage is a phase-2 flag on the same path. */
export const CRAWL_ENVS = ["prod", "stage"] as const;
export type CrawlEnv = (typeof CRAWL_ENVS)[number];

export interface CrawlInput {
  /** The surrogate `sites.id`. */
  readonly siteId: number;
  readonly env: CrawlEnv;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly status: CrawlStatus;
  readonly deployedTag: string | null;
  readonly registrySha: string | null;
  readonly pagesSeen: number;
  readonly wasThrottled: boolean;
  /**
   * How large the truth source was when this crawl was seeded (step 5, `006`).
   *
   * Required and nullable, like every other nullable column here: `null` is the honest
   * value for a crawl nobody resolved a truth source for, and a caller that may omit the
   * field is a caller that can forget the inventory size, compile clean, and only find
   * out when `analyse` refuses much later. The three counts are the union, WP REST alone
   * and the sitemap alone; see `006_truth_source.sql` for why `sitemap-invisible` is
   * arithmetic over them rather than a fourth column.
   */
  readonly truthSourceUrls: number | null;
  readonly truthSourceRestUrls: number | null;
  readonly truthSourceSitemapUrls: number | null;
  /**
   * The site's taxonomy vocabulary as this crawl resolved it (`010`, PRD §4). It is
   * what turns `pages.post_type` into the Excluded decision, and it lives on the crawl
   * rather than the site so that re-analysing an old crawl uses the vocabulary that
   * crawl was classified against.
   *
   * Empty means no name is known — a sitemap-only site declares none — and an empty
   * vocabulary excludes nothing.
   */
  readonly taxonomies: readonly string[];
}

export interface CrawlRow extends CrawlInput {
  readonly id: number;
}

const COLUMNS = `id, site_id AS "siteId", env, started_at AS "startedAt",
  finished_at AS "finishedAt", status, deployed_tag AS "deployedTag",
  registry_sha AS "registrySha", pages_seen AS "pagesSeen",
  was_throttled AS "wasThrottled", truth_source_urls AS "truthSourceUrls",
  truth_source_rest_urls AS "truthSourceRestUrls",
  truth_source_sitemap_urls AS "truthSourceSitemapUrls", taxonomies`;

export async function insertCrawl(db: Queryable, crawl: CrawlInput): Promise<CrawlRow> {
  const { rows } = await db.query<CrawlRow>(
    `INSERT INTO crawls (site_id, env, started_at, finished_at, status, deployed_tag,
                         registry_sha, pages_seen, was_throttled, truth_source_urls,
                         truth_source_rest_urls, truth_source_sitemap_urls, taxonomies)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${COLUMNS}`,
    [
      crawl.siteId,
      crawl.env,
      crawl.startedAt,
      crawl.finishedAt,
      crawl.status,
      crawl.deployedTag,
      crawl.registrySha,
      crawl.pagesSeen,
      crawl.wasThrottled,
      crawl.truthSourceUrls,
      crawl.truthSourceRestUrls,
      crawl.truthSourceSitemapUrls,
      crawl.taxonomies,
    ],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `insertCrawl wrote no row for site ${crawl.siteId} (${crawl.env}, ${crawl.status})`,
    );
  }
  return row;
}

export async function findCrawl(db: Queryable, id: number): Promise<CrawlRow | null> {
  const { rows } = await db.query<CrawlRow>(
    `SELECT ${COLUMNS} FROM crawls WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * The site's most recent **complete** crawl — what `link-graph report` re-reads (step
 * 7.6). `null` when the site has never had one, which the caller must refuse rather
 * than report as a site with nothing to say.
 *
 * `status = 'complete'` and not "the latest crawl": a partial crawl holds an arbitrary
 * subset of the site, `analyse` refuses it outright, and so it has no metrics row and no
 * classified pages. Reporting from one would print a short orphan list as though it were
 * the site (engineering guide §1).
 *
 * `env = 'prod'` because phase 1 crawls prod only (PRD §8) and staging is a different
 * site, not a fresher copy of this one: **measured 2026-08-25, every page of
 * integrity-2024.staging02 carries `noindex`**, so a staging crawl classifies every page
 * Excluded and reports `orphans: 0` with `linked: 0` (PRD §15). Letting one become "the
 * site's last crawl" would print that as a clean bill of health. Nothing writes `stage`
 * yet — `crawl()` hardcodes `prod` — but `loadFixture` can, and step 14 makes it a real
 * value; this is an `if` for a decision already made rather than a parameter.
 *
 * `NULLS LAST` is load-bearing, because Postgres sorts NULLs first on a DESC (measured).
 * Every complete crawl the crawler writes has a `finished_at` — `finishCrawl` requires
 * one — so the only way to get a NULL here is a fixture that omitted it, and sorting
 * those last keeps such a row from displacing a real crawl.
 */
export async function findLatestCompleteCrawl(
  db: Queryable,
  siteId: number,
): Promise<CrawlRow | null> {
  const { rows } = await db.query<CrawlRow>(
    `SELECT ${COLUMNS} FROM crawls
     WHERE site_id = $1 AND status = 'complete' AND env = 'prod'
     ORDER BY finished_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [siteId],
  );
  return rows[0] ?? null;
}

export interface CrawlOutcome {
  /**
   * `complete` or `partial`, never back to `running`. A crawl that ended early is
   * `partial` and `analyse` refuses it outright (engineering guide §1) — which is why
   * this is a required field with no default rather than something a caller can omit.
   */
  readonly status: Exclude<CrawlStatus, "running">;
  readonly finishedAt: Date;
  /** Page rows written. The crawl's own count of what it saw. */
  readonly pagesSeen: number;
  /** True if any host block was hit during the run (PRD §5.1). */
  readonly wasThrottled: boolean;
}

/**
 * Close a crawl. Only a `running` crawl can be closed, so a second worker finishing the
 * same crawl raises rather than overwriting the first one's verdict — the case where a
 * `partial` would quietly become `complete`.
 */
export async function finishCrawl(
  db: Queryable,
  crawlId: number,
  outcome: CrawlOutcome,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE crawls
     SET status = $2, finished_at = $3, pages_seen = $4, was_throttled = $5
     WHERE id = $1 AND status = 'running'`,
    [
      crawlId,
      outcome.status,
      outcome.finishedAt,
      outcome.pagesSeen,
      outcome.wasThrottled,
    ],
  );
  expectOneRow(
    rowCount,
    `finishCrawl: crawl ${crawlId} is not running, so it cannot be finished as ` +
      `${outcome.status}`,
  );
}

/**
 * Put a crawl back into `running` so a worker can carry on with it.
 *
 * A `complete` crawl is refused: its page set has already been reported as the whole
 * site, and adding rows to it afterwards would change a number someone has read.
 */
export async function reopenCrawl(db: Queryable, crawlId: number): Promise<void> {
  // The status is read in the same statement so the refusal can name it: "complete or
  // missing" leaves an operator resuming a crawl with the one fact they came for still
  // unknown (engineering guide §6, errors carry context).
  const { rows } = await db.query<{ status: CrawlStatus }>(
    `WITH found AS (SELECT id, status FROM crawls WHERE id = $1),
          reopened AS (
            UPDATE crawls SET status = 'running', finished_at = NULL
            WHERE id = $1 AND status <> 'complete'
            RETURNING status)
     SELECT status FROM found`,
    [crawlId],
  );
  const status = rows[0]?.status;
  if (status === undefined) throw new Error(`reopenCrawl: no crawl ${crawlId}`);
  if (status === "complete") {
    throw new Error(
      `reopenCrawl: crawl ${crawlId} is complete, so it cannot be resumed. Its page ` +
        `set has already been reported as the whole site; crawl the site again instead.`,
    );
  }
}

export interface CrawlRowCounts {
  readonly pages: number;
  readonly links: number;
}

/** What a crawl actually wrote — the `{ pages, links }` of PRD §5.0's seam. */
export async function countCrawlRows(
  db: Queryable,
  crawlId: number,
): Promise<CrawlRowCounts> {
  const { rows } = await db.query<CrawlRowCounts>(
    `SELECT (SELECT count(*) FROM pages WHERE crawl_id = $1)::int AS pages,
            (SELECT count(*) FROM links WHERE crawl_id = $1)::int AS links`,
    [crawlId],
  );
  const counts = rows[0];
  if (counts === undefined) {
    throw new Error(`countCrawlRows returned no row for crawl ${crawlId}`);
  }
  return counts;
}
