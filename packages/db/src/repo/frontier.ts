/** `crawl_frontier` — what a crawl still owes a page row (PRD §5.1, `009`). */
import { expectOneRow, type Queryable } from "../pool.js";

export interface FrontierEntry {
  readonly urlNormalized: string;
  /** True for the truth source's own URLs, false for anything discovered. */
  readonly inTruthSource: boolean;
}

export interface FrontierRow extends FrontierEntry {
  /** Attempts so far, across resumes. Zero on a URL nobody has tried yet. */
  readonly attempts: number;
}

export interface FrontierCounts {
  readonly total: number;
  /** Have a page row. Equal to the crawl's page count, by construction. */
  readonly fetched: number;
  /** Still owing a page row. A complete crawl ends with zero of these. */
  readonly pending: number;
  /** Pending, and the last attempt failed. */
  readonly failed: number;
}

/**
 * Add URLs to a crawl's frontier, ignoring the ones already there.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert: the first insert wins, which is what
 * keeps `in_truth_source` true for a seed that is later discovered as an ordinary link.
 * Seeds are inserted before the crawl starts, so "first" is always the truth source.
 *
 * Returns how many rows were new. Nothing in the crawl loop reads it; the frontier's
 * integration test does, because "the second insert changed nothing" is the whole
 * behaviour of the line above.
 */
export async function addToFrontier(
  db: Queryable,
  crawlId: number,
  entries: readonly FrontierEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO crawl_frontier (crawl_id, url_normalized, in_truth_source)
     SELECT $1, u.url, u.in_truth_source
     FROM unnest($2::text[], $3::boolean[]) AS u(url, in_truth_source)
     ON CONFLICT (crawl_id, url_normalized) DO NOTHING`,
    [crawlId, entries.map((e) => e.urlNormalized), entries.map((e) => e.inTruthSource)],
  );
  return rowCount ?? 0;
}

/**
 * The next URL owing a page row, in insertion order, or `null` when none is left.
 *
 * No `FOR UPDATE SKIP LOCKED`: one worker owns one crawl in phase 1, and a lock mode
 * chosen for a concurrency that does not exist yet would be untested machinery. Step 10
 * introduces the worker pool and is where that belongs.
 */
export async function nextFrontierUrl(
  db: Queryable,
  crawlId: number,
): Promise<FrontierRow | null> {
  const { rows } = await db.query<FrontierRow>(
    `SELECT url_normalized AS "urlNormalized", in_truth_source AS "inTruthSource",
            attempts
     FROM crawl_frontier
     WHERE crawl_id = $1 AND fetched_at IS NULL
     ORDER BY id
     LIMIT 1`,
    [crawlId],
  );
  return rows[0] ?? null;
}

/**
 * Mark a URL as having its page row. Called in the same transaction as the INSERT into
 * `pages`, so the two cannot disagree; it raises if the row is missing, because a
 * frontier that lost an entry mid-crawl would silently re-fetch it later.
 */
export async function markFrontierFetched(
  db: Queryable,
  crawlId: number,
  urlNormalized: string,
  at: Date,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE crawl_frontier
     SET fetched_at = $3, attempts = attempts + 1, last_error = NULL
     WHERE crawl_id = $1 AND url_normalized = $2 AND fetched_at IS NULL`,
    [crawlId, urlNormalized, at],
  );
  expectOneRow(
    rowCount,
    `markFrontierFetched: crawl ${crawlId} has no pending frontier entry for ` +
      `${urlNormalized}`,
  );
}

/**
 * Record a failed attempt, leaving the URL pending so a resume tries it again. The
 * attempt is counted whether it succeeded or failed, which is what makes a URL that
 * fails on every resume visible rather than merely slow.
 */
export async function recordFrontierFailure(
  db: Queryable,
  crawlId: number,
  urlNormalized: string,
  error: string,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE crawl_frontier
     SET attempts = attempts + 1, last_error = $3
     WHERE crawl_id = $1 AND url_normalized = $2 AND fetched_at IS NULL`,
    [crawlId, urlNormalized, error],
  );
  expectOneRow(
    rowCount,
    `recordFrontierFailure: crawl ${crawlId} has no pending frontier entry for ` +
      `${urlNormalized}`,
  );
}

/**
 * How much of the frontier is left. `pending > 0` at the end of a run is exactly what
 * makes a crawl `partial` rather than `complete` — the one number that stops a short
 * page list from reading as a small site (engineering guide §1).
 */
export async function countFrontier(
  db: Queryable,
  crawlId: number,
): Promise<FrontierCounts> {
  const { rows } = await db.query<FrontierCounts>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE fetched_at IS NOT NULL)::int AS fetched,
            count(*) FILTER (WHERE fetched_at IS NULL)::int AS pending,
            count(*) FILTER (WHERE last_error IS NOT NULL)::int AS failed
     FROM crawl_frontier WHERE crawl_id = $1`,
    [crawlId],
  );
  const counts = rows[0];
  if (counts === undefined) {
    throw new Error(`countFrontier returned no row for crawl ${crawlId}`);
  }
  return counts;
}
