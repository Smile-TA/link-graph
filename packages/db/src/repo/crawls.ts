/** `crawls` — one crawl of one site (PRD §7). */
import type { Queryable } from "../pool.js";

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
}

export interface CrawlRow extends CrawlInput {
  readonly id: number;
}

const COLUMNS = `id, site_id AS "siteId", env, started_at AS "startedAt",
  finished_at AS "finishedAt", status, deployed_tag AS "deployedTag",
  registry_sha AS "registrySha", pages_seen AS "pagesSeen",
  was_throttled AS "wasThrottled"`;

export async function insertCrawl(db: Queryable, crawl: CrawlInput): Promise<CrawlRow> {
  const { rows } = await db.query<CrawlRow>(
    `INSERT INTO crawls (site_id, env, started_at, finished_at, status, deployed_tag,
                         registry_sha, pages_seen, was_throttled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
