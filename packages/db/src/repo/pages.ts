/** `pages` — the nodes of one crawl's graph (PRD §7). */
import type { Queryable } from "../pool.js";

export interface PageInput {
  /** Node identity: absolute, normalized, canonical host. */
  readonly urlNormalized: string;
  readonly path: string;
  readonly postType: string | null;
  /** `null` = never fetched. Never read as 200. */
  readonly statusCode: number | null;
  /** `null` until analyse computes it. */
  readonly depth: number | null;
  readonly inTruthSource: boolean;
  readonly indexable: boolean;
  readonly canonicalTo: string | null;
  readonly redirectTo: string | null;
  /** `null` = not classified. The vocabulary belongs to analyse (step 4). */
  readonly class: string | null;
}

export interface PageRow extends PageInput {
  readonly id: number;
  readonly crawlId: number;
}

const COLUMNS = `id, crawl_id AS "crawlId", url_normalized AS "urlNormalized", path,
  post_type AS "postType", status_code AS "statusCode", depth,
  in_truth_source AS "inTruthSource", indexable, canonical_to AS "canonicalTo",
  redirect_to AS "redirectTo", class`;

/**
 * Insert every page of a crawl in one statement.
 *
 * No `ON CONFLICT DO NOTHING`: a duplicate URL inside one crawl must raise, because
 * silently keeping the first row would halve that page's edges and its inbound count
 * (engineering guide §1). The `unnest` form is one round trip whatever the page
 * count, which is what a 3,000-page site needs.
 *
 * Returns the assigned ids paired with their URL rather than in input order —
 * `RETURNING` row order is not guaranteed, and nothing here needs to rely on it.
 */
export async function insertPages(
  db: Queryable,
  crawlId: number,
  pages: readonly PageInput[],
): Promise<{ id: number; urlNormalized: string }[]> {
  if (pages.length === 0) return [];
  const { rows } = await db.query<{ id: number; urlNormalized: string }>(
    `INSERT INTO pages (crawl_id, url_normalized, path, post_type, status_code, depth,
                        in_truth_source, indexable, canonical_to, redirect_to, class)
     SELECT $1, u.url, u.path, u.post_type, u.status_code, u.depth,
            u.in_truth_source, u.indexable, u.canonical_to, u.redirect_to, u.class
     FROM unnest($2::text[], $3::text[], $4::text[], $5::integer[], $6::integer[],
                 $7::boolean[], $8::boolean[], $9::text[], $10::text[], $11::text[])
       AS u(url, path, post_type, status_code, depth, in_truth_source, indexable,
            canonical_to, redirect_to, class)
     RETURNING id, url_normalized AS "urlNormalized"`,
    [
      crawlId,
      pages.map((p) => p.urlNormalized),
      pages.map((p) => p.path),
      pages.map((p) => p.postType),
      pages.map((p) => p.statusCode),
      pages.map((p) => p.depth),
      pages.map((p) => p.inTruthSource),
      pages.map((p) => p.indexable),
      pages.map((p) => p.canonicalTo),
      pages.map((p) => p.redirectTo),
      pages.map((p) => p.class),
    ],
  );
  // Every caller's page count is load-bearing downstream, so the check lives here
  // rather than in one of them: a crawl silently short of a page is a page with no
  // inbound edges and no outbound ones — an orphan that is really a bookkeeping bug.
  if (rows.length !== pages.length) {
    throw new Error(
      `insertPages wrote ${rows.length} of ${pages.length} pages for crawl ${crawlId}`,
    );
  }
  return rows;
}

export async function listPages(db: Queryable, crawlId: number): Promise<PageRow[]> {
  const { rows } = await db.query<PageRow>(
    `SELECT ${COLUMNS} FROM pages WHERE crawl_id = $1 ORDER BY url_normalized`,
    [crawlId],
  );
  return rows;
}
