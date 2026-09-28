/**
 * `external_urls` — external link status, keyed by URL and shared across every site
 * (PRD §6.1). The TTL policy reads `lastChecked`; this table, not lychee's cache, is
 * the source of truth.
 */
import type { Queryable } from "../pool.js";

export interface ExternalUrlInput {
  readonly urlNormalized: string;
  /** `null` = never checked. Must not be read as "checked long ago and fine". */
  readonly lastChecked: Date | null;
  readonly statusCode: number | null;
  /** A host that blocks us (429/403) is unverified, never broken. */
  readonly unverified: boolean;
  /**
   * Why the check was inconclusive (`012_external_url_detail.sql`). Required whenever
   * `unverified` is true — a SQL CHECK refuses the row otherwise — because "their bot
   * protection refused us" and "our own egress was broken" are the same word with
   * different remedies, and the second one turns the whole table unverified at once.
   */
  readonly detail: string | null;
}

const COLUMNS = `url_normalized AS "urlNormalized", last_checked AS "lastChecked",
  status_code AS "statusCode", unverified, detail`;

export async function upsertExternalUrl(
  db: Queryable,
  url: ExternalUrlInput,
): Promise<void> {
  await upsertExternalUrls(db, [url]);
}

/**
 * Every result of one linkcheck run in one statement, for the reason `insertLinks` and
 * `setPageClasses` take arrays: a crawl of integrity.com has 642 distinct external URLs
 * (measured on the stored 2026-08-25 crawl), and 642 round trips to write them is 642
 * chances for a run to be interrupted halfway through recording what it already spent
 * third-party requests learning.
 *
 * Returns the number of rows written, so a caller can refuse a run that wrote fewer
 * rows than it checked rather than reporting the checks it lost as though they had
 * never been due.
 */
export async function upsertExternalUrls(
  db: Queryable,
  urls: readonly ExternalUrlInput[],
): Promise<number> {
  if (urls.length === 0) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO external_urls (url_normalized, last_checked, status_code, unverified,
                                detail)
     SELECT u.url, u.last_checked, u.status_code, u.unverified, u.detail
     FROM unnest($1::text[], $2::timestamptz[], $3::integer[], $4::boolean[],
                 $5::text[])
       AS u(url, last_checked, status_code, unverified, detail)
     ON CONFLICT (url_normalized) DO UPDATE SET
       last_checked = excluded.last_checked, status_code = excluded.status_code,
       unverified = excluded.unverified, detail = excluded.detail`,
    [
      urls.map((u) => u.urlNormalized),
      urls.map((u) => u.lastChecked),
      urls.map((u) => u.statusCode),
      urls.map((u) => u.unverified),
      urls.map((u) => u.detail),
    ],
  );
  return rowCount ?? 0;
}

export async function findExternalUrl(
  db: Queryable,
  urlNormalized: string,
): Promise<ExternalUrlInput | null> {
  const { rows } = await db.query<ExternalUrlInput>(
    `SELECT ${COLUMNS} FROM external_urls WHERE url_normalized = $1`,
    [urlNormalized],
  );
  return rows[0] ?? null;
}

/**
 * The external URLs of one crawl that nobody has checked recently enough — the input to
 * a linkcheck run (PRD §6.1).
 *
 * **`checkedBefore` is passed in, not computed here.** The TTL is policy and the clock
 * is injected at the boundary (guide §4.4); this function only knows how to ask.
 *
 * Two properties make the sharing PRD §6.1 calls "the single strongest argument for
 * centralisation" actually happen, and both are in the join rather than in a comment:
 *
 * - The join is on `url_normalized` alone, with no site or crawl in it, so a URL another
 *   site's run checked an hour ago is not due here. That is what makes a destination
 *   linked from 40 sites cost one request.
 * - `last_checked IS NULL` is due. A row can exist with a NULL `last_checked` (003 says
 *   so), and reading "there is a row" as "it has been checked" would drop a URL out of
 *   every future run — a link that is never checked and never reported as unchecked.
 *
 * `DISTINCT` is what makes the count 642 rather than 30,456: integrity.com's crawl holds
 * 30,456 external edges over 642 distinct targets, and the checker's unit is the target.
 */
export async function listExternalUrlsDue(
  db: Queryable,
  crawlId: number,
  checkedBefore: Date,
): Promise<string[]> {
  const { rows } = await db.query<{ url: string }>(
    `SELECT DISTINCT l.to_url_normalized AS url
     FROM links l
     LEFT JOIN external_urls e ON e.url_normalized = l.to_url_normalized
     WHERE l.crawl_id = $1 AND l.is_external
       AND (e.last_checked IS NULL OR e.last_checked < $2)
     ORDER BY 1`,
    [crawlId, checkedBefore],
  );
  return rows.map((row) => row.url);
}

export interface ExternalLinkRow {
  readonly urlNormalized: string;
  /** `null` = never checked (linkcheck hasn't reached it yet, or it isn't due). */
  readonly lastChecked: Date | null;
  readonly statusCode: number | null;
  readonly unverified: boolean;
  readonly detail: string | null;
}

/**
 * One page of a crawl's distinct external links, joined against `external_urls` for
 * their check status (docs/notes.md item 11's "external links list"). A `LEFT JOIN`,
 * not an inner one: a URL `checkExternalUrls` hasn't reached yet has no `external_urls`
 * row at all, and dropping it here would under-report the site's external surface
 * rather than showing it as "not yet checked" (`lastChecked: null`) — the same
 * distinction `listExternalUrlsDue`'s own `LEFT JOIN` makes.
 *
 * Ordered worst-first (unverified/broken before 2xx) so the finding a reviewer wants —
 * "what's actually wrong" — is on page one rather than somewhere past a wall of 200s;
 * `PagedResult<PageRow>`'s `listPagesPage` above orders alphabetically instead because
 * there every row is equally "fine", and there is no such priority to sort by.
 */
export async function listExternalLinksForCrawl(
  db: Queryable,
  crawlId: number,
  limit: number,
  offset: number,
): Promise<{ rows: ExternalLinkRow[]; total: number }> {
  const [{ rows }, { rows: countRows }] = await Promise.all([
    db.query<ExternalLinkRow>(
      `SELECT l.to_url_normalized AS "urlNormalized", e.last_checked AS "lastChecked",
              e.status_code AS "statusCode", coalesce(e.unverified, false) AS unverified,
              e.detail
       FROM (SELECT DISTINCT to_url_normalized FROM links
             WHERE crawl_id = $1 AND is_external) l
       LEFT JOIN external_urls e ON e.url_normalized = l.to_url_normalized
       ORDER BY
         e.last_checked IS NULL DESC,        -- not-yet-checked first
         coalesce(e.unverified, false) DESC, -- then unverified
         e.status_code >= 400 DESC,          -- then broken
         l.to_url_normalized
       LIMIT $2 OFFSET $3`,
      [crawlId, limit, offset],
    ),
    db.query<{ total: number }>(
      `SELECT count(DISTINCT to_url_normalized)::int AS total
       FROM links WHERE crawl_id = $1 AND is_external`,
      [crawlId],
    ),
  ]);
  return { rows, total: countRows[0]?.total ?? 0 };
}

/**
 * Every distinct external URL of one crawl, due or not.
 *
 * The denominator, and it exists for engineering guide §1: a run that checked 3 URLs
 * because the other 639 were still fresh must not let a reader read "3 external URLs"
 * as the site's external surface. `LinkcheckResult` carries both numbers so the sentence
 * printed can be "3 of 642 were due".
 */
export async function countExternalUrls(db: Queryable, crawlId: number): Promise<number> {
  const { rows } = await db.query<{ total: number }>(
    `SELECT count(DISTINCT to_url_normalized)::int AS total
     FROM links WHERE crawl_id = $1 AND is_external`,
    [crawlId],
  );
  const total = rows[0]?.total;
  if (total === undefined) {
    throw new Error(`countExternalUrls returned no row for crawl ${crawlId}`);
  }
  return total;
}
