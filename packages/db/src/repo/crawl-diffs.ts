/** `crawl_diffs` — what changed between two consecutive crawls (step 13). */
import type { Queryable } from "../pool.js";

export interface CrawlDiffInput {
  readonly fromCrawlId: number;
  readonly toCrawlId: number;
  /** Free text so far: the vocabulary belongs to step 13, not to the schema. */
  readonly kind: string;
  readonly url: string;
  readonly detail: string | null;
}

const COLUMNS = `id, from_crawl_id AS "fromCrawlId", to_crawl_id AS "toCrawlId", kind,
  url, detail`;

export async function insertCrawlDiff(
  db: Queryable,
  diff: CrawlDiffInput,
): Promise<void> {
  await db.query(
    `INSERT INTO crawl_diffs (from_crawl_id, to_crawl_id, kind, url, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [diff.fromCrawlId, diff.toCrawlId, diff.kind, diff.url, diff.detail],
  );
}

export async function listCrawlDiffs(
  db: Queryable,
  toCrawlId: number,
): Promise<(CrawlDiffInput & { id: number })[]> {
  const { rows } = await db.query<CrawlDiffInput & { id: number }>(
    `SELECT ${COLUMNS} FROM crawl_diffs WHERE to_crawl_id = $1 ORDER BY id`,
    [toCrawlId],
  );
  return rows;
}

export interface DiffEventRow {
  readonly subject: string;
  readonly kind: "appeared" | "resolved";
  readonly at: Date;
}

/**
 * Every appearance/resolution recorded for these specific subjects — a site's reviewed
 * findings, in practice — timestamped by the crawl that found it. What
 * `reappearedSince` (`@link-graph/diffs`) checks a review against to close PRD §7.1's
 * "silently reactivates its old review" gap. Joined to `crawls` for `finished_at`
 * because `crawl_diffs` itself carries no timestamp of its own.
 *
 * Scoped to `subjects` rather than the whole site: only a subject with a review can
 * ever need this history, and a site accumulates `crawl_diffs` rows indefinitely (they
 * are never rolled up the way `pages`/`links` are), so scanning every diff the site has
 * ever had on every `report` run would grow unboundedly with the site's age rather than
 * with the size of what is actually being asked.
 */
export async function listDiffEventsForSubjects(
  db: Queryable,
  siteId: number,
  kindPrefix: string,
  subjects: readonly string[],
): Promise<DiffEventRow[]> {
  if (subjects.length === 0) return [];
  const { rows } = await db.query<DiffEventRow>(
    `SELECT d.url AS subject,
            (CASE WHEN d.kind = $2 THEN 'appeared' ELSE 'resolved' END) AS kind,
            c.finished_at AS at
     FROM crawl_diffs d
     JOIN crawls c ON c.id = d.to_crawl_id
     WHERE c.site_id = $1 AND d.kind IN ($2, $3) AND c.finished_at IS NOT NULL
       AND d.url = ANY($4)
     ORDER BY c.finished_at`,
    [siteId, `${kindPrefix}_appeared`, `${kindPrefix}_resolved`, subjects],
  );
  return rows;
}
