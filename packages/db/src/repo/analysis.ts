/**
 * The graph maths of step 4, as SQL.
 *
 * It lives here rather than in `packages/analyse` for two reasons. PRD §7: inbound
 * counts are a `GROUP BY` and depth is a recursive CTE, so at this scale no in-memory
 * graph layer is needed. Engineering guide §6: SQL lives in the db package, not inlined
 * in a service. What is left in `analyse` is the taxonomy of PRD §2, which is a pure
 * function over the numbers these queries return.
 *
 * **Measured at the scale PRD §7 states**, on a throwaway synthetic crawl — 3,000 pages,
 * 200 links each, 40 nav targets on every page, postgres:18-alpine, 2026-08-20. The
 * whole pass took ~21s: ~17s marking boilerplate, ~3s depth, ~0.6s for the two reads.
 * Of the 17s, ~13s is writing 600,000 rows rather than deciding what to write — the same
 * aggregate with the UPDATE removed is 1.0s.
 *
 * That is fine for a weekly per-site job, and it is recorded here so nobody goes looking
 * for the cost in the wrong place. The harness was a scratch script rather than a
 * committed benchmark, so the figures are a bearing rather than a regression gate; the
 * shape above is enough to rebuild it.
 */
import { PAGE_COLUMNS, type PageClass, type PageRow } from "./pages.js";
import type { Queryable } from "../pool.js";

/**
 * The pages the crawl actually got a response for. `markBoilerplateLinks` uses this as
 * its denominator and `countFetchedPages` counts it; they must agree, so it is written
 * once.
 */
const FETCHED = `crawl_id = $1 AND status_code IS NOT NULL`;

/**
 * An internal edge whose target served an error — what `crawl_metrics.broken` counts,
 * and what `listBrokenLinkFindings` lists the targets of. Written once for the reason
 * `FETCHED` is: the report refuses to print when the edge count and the target list
 * disagree, so a drift between the two predicates would make the report unprintable
 * rather than wrong. Assumes the query aliases `links` as `l` and its target page as
 * `t`, as both callers do.
 */
export const BROKEN_INTERNAL_EDGE = `NOT l.is_external AND t.status_code >= 400`;

/**
 * Mark every edge of a crawl boilerplate or contextual (PRD §2, §6): boilerplate is a
 * `(target, anchor)` pair appearing on more than `thresholdPct`% of the crawl's fetched
 * pages.
 *
 * Three decisions the SQL encodes:
 *
 * - **The denominator is pages actually fetched**, not every page row. A frontier row
 *   the crawl never reached carries no links, so counting it lowers every ratio, marks
 *   less boilerplate, and so reports fewer soft orphans — a wrong answer in the
 *   direction of good news (engineering guide §1).
 * - **Self-links count towards the pair frequency.** The rule is about how often a pair
 *   appears in the markup; a nav link to the current page is an appearance.
 * - **External edges are marked too.** PRD §6 classifies every edge on both axes, and a
 *   footer link to LinkedIn on every page is boilerplate whoever it points at.
 *
 * **A join rather than a correlated `EXISTS`, for readability and not for speed.** The
 * first draft set `is_boilerplate = EXISTS (SELECT 1 FROM boilerplate …)`, a SubPlan per
 * link row that no index can serve, and it looked like the expensive part. Measured on
 * 600k links the two forms are within noise of each other, because the cost is the row
 * writes both of them pay. So this form was kept for reading more plainly than a nested
 * CTE plus a correlated subquery, and for no other reason.
 *
 * Every link row matches exactly one `pair` row by construction, since `pair` is grouped
 * from the same rows, so every edge of the crawl is written; that is what
 * `LinkAnalysisCounts.unmarked` then verifies.
 */
export async function markBoilerplateLinks(
  db: Queryable,
  crawlId: number,
  thresholdPct: number,
): Promise<void> {
  await db.query(
    `WITH fetched AS (
       SELECT count(*)::double precision AS pages FROM pages WHERE ${FETCHED}
     ),
     pair AS (
       SELECT to_url_normalized, anchor, count(DISTINCT from_page_id) AS pages
       FROM links WHERE crawl_id = $1
       GROUP BY to_url_normalized, anchor
     )
     UPDATE links l
     SET is_boilerplate = p.pages > ($2::double precision / 100) * f.pages
     FROM pair p CROSS JOIN fetched f
     WHERE l.crawl_id = $1
       AND l.to_url_normalized = p.to_url_normalized AND l.anchor = p.anchor`,
    [crawlId, thresholdPct],
  );
}

/**
 * How many pages of this crawl were fetched. Zero means the crawl recorded page rows
 * and never got a response for any of them, which must never be analysed: it is the
 * pw-template bug engineering guide §1 opens with, where a crawl that fetched nothing
 * reports "0 orphans" as though that were good news.
 */
export async function countFetchedPages(db: Queryable, crawlId: number): Promise<number> {
  const { rows } = await db.query<{ fetched: number }>(
    `SELECT count(*)::int AS fetched FROM pages WHERE ${FETCHED}`,
    [crawlId],
  );
  return rows[0]?.fetched ?? 0;
}

/**
 * Pages of this crawl that the truth source listed **and that the crawl got a response
 * for** — the numerator of the coverage check `analyse` refuses on (step 5,
 * `006_truth_source.sql`).
 *
 * `${FETCHED}` is load-bearing, and this counted every row regardless of status first.
 * Gate 2 found what that costs from step 6 onwards: a crawler that seeds its frontier
 * from the truth source writes a row per inventory URL before fetching anything, so the
 * ratio would be 1 by construction and the refusal would be vacuous exactly when it
 * starts to matter. A row with a NULL status_code is a URL whose links are unknown, so
 * it is not coverage of that URL (`002_crawls.sql` on the column).
 */
export async function countTruthSourcePages(
  db: Queryable,
  crawlId: number,
): Promise<number> {
  const { rows } = await db.query<{ pages: number }>(
    `SELECT count(*)::int AS pages FROM pages WHERE ${FETCHED} AND in_truth_source`,
    [crawlId],
  );
  return rows[0]?.pages ?? 0;
}

/**
 * Shortest click depth from the root page over **all** internal links, boilerplate
 * included (implementation plan, step 4: a page in the global nav genuinely is one click
 * deep). Pages with no path from the root keep a NULL depth, which is what
 * `crawl_metrics.unreachable` counts.
 *
 * **Breadth-first over a frontier, and it has to be.** The obvious recursive CTE —
 * `SELECT l.to_page_id, w.depth + 1 … UNION` — dedupes whole `(id, depth)` rows, so on
 * any site with a global nav (that is, all of them) a page is re-emitted at every depth
 * it is reachable at and the recursion never runs out of new rows. It then terminates
 * only against a depth ceiling: measured at 600k links it pushed ~19M intermediate rows
 * through the dedupe, taking 11.8s, for an answer whose real diameter is 2 — and a
 * ceiling that is ever actually reached silently reports deeper pages as unreachable.
 *
 * Carrying the frontier and the visited set as arrays instead visits each edge once per
 * level and stops at the true diameter: 3.3s on the same data, and no ceiling to
 * overrun. `DISTINCT` runs *before* the `= ANY (seen)` test on purpose — testing every
 * edge against the visited array is what would make the array form quadratic, whereas
 * testing the deduplicated candidate set is at most pages × pages integer comparisons.
 * BFS reaches each page first at its shortest depth, so no `min()` is needed.
 */
export async function computePageDepths(
  db: Queryable,
  crawlId: number,
  rootPageId: number,
): Promise<void> {
  // Only rewrites rows a previous run wrote, so a first run touches nothing: a re-run
  // must not leave a stale depth on a page that is no longer reachable.
  await db.query(
    `UPDATE pages SET depth = NULL WHERE crawl_id = $1 AND depth IS NOT NULL`,
    [crawlId],
  );
  await db.query(
    `WITH RECURSIVE bfs AS (
       SELECT ARRAY[$2::bigint] AS frontier, ARRAY[$2::bigint] AS seen, 0 AS depth
       UNION ALL
       SELECT next.ids, b.seen || next.ids, b.depth + 1
       FROM bfs b
       CROSS JOIN LATERAL (
         SELECT array_agg(candidate.id) AS ids
         FROM (
           -- to_page_id is non-null only for a page row of this same crawl, so it is
           -- already the "internal, and we have a row for it" case; is_external needs
           -- no test. A row whose fetch failed still counts as reachable: a visitor
           -- following that link does arrive somewhere, and what it served is a
           -- separate question, counted by LinkAnalysisCounts.internalUnresolved.
           SELECT DISTINCT l.to_page_id AS id
           FROM links l
           WHERE l.crawl_id = $1 AND l.from_page_id = ANY (b.frontier)
             AND l.to_page_id IS NOT NULL
         ) candidate
         WHERE NOT candidate.id = ANY (b.seen)
       ) next
       WHERE next.ids IS NOT NULL
     ),
     reached AS (SELECT unnest(frontier) AS id, depth FROM bfs)
     UPDATE pages p SET depth = r.depth
     FROM reached r WHERE p.crawl_id = $1 AND p.id = r.id`,
    [crawlId, rootPageId],
  );
}

/** One page of the crawl, with the inbound edge counts PRD §2's taxonomy needs. */
export interface PageAnalysisFact extends PageRow {
  /** Inbound internal edges from other pages of this crawl. Self-links excluded. */
  readonly inboundTotal: number;
}

/**
 * Every page of the crawl with its inbound edge counts — the plan's first query, over
 * the page row itself so that the column list has one owner (`PAGE_COLUMNS`).
 *
 * **Self-links are excluded from the inbound counts.** A nav link on `/contact-us/`
 * pointing at `/contact-us/` cannot bring a visitor to that page, so counting it would
 * let a page whose only inbound edge is its own nav entry pass as reachable — an orphan
 * hidden by a bookkeeping choice. This differs from the boilerplate frequency count
 * above, deliberately: that measures appearances, this measures reachability.
 *
 * **The contextual count is deliberately absent.** It was here to split
 * boilerplate-only inbound edges from the rest, which is the soft-orphan rule dropped
 * on 2026-08-20 (`007_drop_soft_orphan.sql`). The taxonomy now asks only whether any
 * inbound edge exists, and a count nothing reads is a number that goes wrong quietly.
 * `links.is_boilerplate` is still computed and stored for PRD §9's section matrix.
 */
export async function listPageAnalysisFacts(
  db: Queryable,
  crawlId: number,
): Promise<PageAnalysisFact[]> {
  const { rows } = await db.query<PageAnalysisFact>(
    `SELECT ${PAGE_COLUMNS},
            coalesce(i.total, 0)::int AS "inboundTotal"
     FROM pages p
     LEFT JOIN (
       SELECT to_page_id, count(*) AS total
       FROM links
       WHERE crawl_id = $1 AND NOT is_external AND to_page_id IS NOT NULL
         AND to_page_id <> from_page_id
       GROUP BY to_page_id
     ) i ON i.to_page_id = p.id
     WHERE p.crawl_id = $1`,
    [crawlId],
  );
  return rows;
}

/**
 * Write the computed class onto every page. Returns the number of rows written, so the
 * caller can refuse a run that classified fewer pages than it read.
 */
export async function setPageClasses(
  db: Queryable,
  crawlId: number,
  classes: readonly { readonly id: number; readonly class: PageClass }[],
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE pages p SET class = u.class
     FROM unnest($2::bigint[], $3::text[]) AS u(id, class)
     WHERE p.crawl_id = $1 AND p.id = u.id`,
    [crawlId, classes.map((c) => c.id), classes.map((c) => c.class)],
  );
  return rowCount ?? 0;
}

export interface LinkAnalysisCounts {
  /** Every edge of the crawl. Zero means link extraction produced nothing. */
  readonly total: number;
  /** Internal edges pointing at a page of this crawl that did not serve. */
  readonly broken: number;
  /**
   * Internal edges whose target status is unknown — either the crawl has no page row
   * for it, or it has a row that was never fetched (`status_code IS NULL`, which
   * 002_crawls.sql allows for a transport error or an unreached frontier entry).
   *
   * Both are the same fact for a reader: nobody checked. Keeping them apart would leave
   * the second in neither counter, so `broken = 0` would read as "no broken internal
   * links" while meaning "13 of these were actually checked" — the exact hole this
   * counter exists to close, one bucket over.
   */
  readonly internalUnresolved: number;
  /** Distinct external target URLs — what step 8 will hand to lychee. */
  readonly external: number;
  /** Edges still carrying NULL `is_boilerplate`. Any at all is a bug, loudly. */
  readonly unmarked: number;
}

export async function countAnalysedLinks(
  db: Queryable,
  crawlId: number,
): Promise<LinkAnalysisCounts> {
  const { rows } = await db.query<LinkAnalysisCounts>(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE ${BROKEN_INTERNAL_EDGE})::int AS broken,
       count(*) FILTER (
         WHERE NOT l.is_external
           AND (l.to_page_id IS NULL OR t.status_code IS NULL))::int
         AS "internalUnresolved",
       count(DISTINCT l.to_url_normalized) FILTER (WHERE l.is_external)::int AS external,
       count(*) FILTER (WHERE l.is_boilerplate IS NULL)::int AS unmarked
     FROM links l
     LEFT JOIN pages t ON t.crawl_id = l.crawl_id AND t.id = l.to_page_id
     WHERE l.crawl_id = $1`,
    [crawlId],
  );
  const counts = rows[0];
  if (counts === undefined) {
    throw new Error(`countAnalysedLinks returned no row for crawl ${crawlId}`);
  }
  return counts;
}
