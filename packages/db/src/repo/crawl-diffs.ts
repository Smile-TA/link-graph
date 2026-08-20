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
