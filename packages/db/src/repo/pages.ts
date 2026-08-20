/** `pages` — the nodes of one crawl's graph (PRD §7). */
import type { Queryable } from "../pool.js";

/**
 * The closed vocabulary of `pages.class` — one page's answer to the orphan question
 * (PRD §2), computed by `analyse` (step 4).
 *
 * It lives here, beside the column, for the reason `crawls.ts` gives for
 * `CRAWL_STATUSES`: declared as a value with the union derived from it, so the fixture
 * parser validates against the same list rather than repeating it. The second copy is
 * the CHECK constraint in `005_analysis.sql`. `packages/analyse` re-exports this.
 *
 * `sitemap-invisible` (PRD §2) is deliberately absent: it means "in WP REST but not in
 * the sitemap", which needs the two truth sources kept apart, and `in_truth_source` is
 * one boolean. It belongs to step 5, and a class that can never be assigned would put a
 * permanent zero in front of a reader.
 */
export const PAGE_CLASSES = [
  /** Something other than the nav or the footer links here — the ordinary case. */
  "linked",
  /** Inbound edges exist and every one of them is boilerplate (PRD §2). */
  "soft_orphan",
  /** In the truth source, includable, and nothing links here at all (PRD §2). */
  "orphan",
  /** Not an orphan by intent: noindex, canonical elsewhere, a redirect, ignore_paths. */
  "excluded",
  /** Crawled, but the inventory does not list it, so the question does not apply. */
  "not_in_truth_source",
  /** No truth source, so the orphan question cannot be answered at all (PRD §2). */
  "undetectable",
] as const;
export type PageClass = (typeof PAGE_CLASSES)[number];

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
  /** `null` = not classified yet, which is never the same as "nothing was found". */
  readonly class: PageClass | null;
}

export interface PageRow extends PageInput {
  readonly id: number;
  readonly crawlId: number;
}

/**
 * Exported so that step 4's analysis queries, which select these same columns with a
 * `p.` alias, do not restate the camelCase alias list — the point of keeping column
 * knowledge in one place (see the note at the top of `sites.ts`).
 */
export const PAGE_COLUMNS = `id, crawl_id AS "crawlId",
  url_normalized AS "urlNormalized", path,
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
    `SELECT ${PAGE_COLUMNS} FROM pages WHERE crawl_id = $1 ORDER BY url_normalized`,
    [crawlId],
  );
  return rows;
}

/**
 * One page by its URL within a crawl — the depth root lookup (step 4). `(crawl_id,
 * url_normalized)` is unique, so this returns at most one row.
 */
export async function findPageByUrl(
  db: Queryable,
  crawlId: number,
  urlNormalized: string,
): Promise<PageRow | null> {
  const { rows } = await db.query<PageRow>(
    `SELECT ${PAGE_COLUMNS} FROM pages WHERE crawl_id = $1 AND url_normalized = $2`,
    [crawlId, urlNormalized],
  );
  return rows[0] ?? null;
}
