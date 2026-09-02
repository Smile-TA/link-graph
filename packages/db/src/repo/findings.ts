/**
 * The findings of one analysed crawl, as a reader reads them (PRD §9's sorted tables).
 *
 * Separate from `repo/analysis.ts`, which is the maths `analyse` runs *once* per crawl
 * and writes back. Nothing here writes anything: these are the read-time queries the
 * report and the review path share, and both are read straight out of what `analyse`
 * already committed — PRD §7.1 rule 1, a review never changes a measured number.
 */
import { BROKEN_INTERNAL_EDGE } from "./analysis.js";
import type { PageClass } from "./pages.js";
import type { Queryable } from "../pool.js";

export interface OrphanFinding {
  /** The finding's subject: node identity for the review row (PRD §7.1 rule 2). */
  readonly urlNormalized: string;
  /**
   * The first field of the orphan evidence tuple (PRD §7.1 rule 5).
   *
   * **It is `'orphan'` on every row this query can return** — the `WHERE` below says so
   * — so today it carries no information, and the digest is effectively `(post_type,
   * status)`. It is selected rather than written as a literal because the column is
   * where the value comes from: a page whose class moved is no longer a finding here at
   * all, and the day a second class becomes reviewable this reads it instead of needing
   * to be found and changed.
   */
  readonly class: PageClass;
  readonly postType: string | null;
  /** `null` = the page was never fetched, which is not the same as 200. */
  readonly statusCode: number | null;
}

/**
 * The pages this crawl classified `orphan`, in URL order.
 *
 * `class = 'orphan'` and not a recomputation of PRD §2's taxonomy: `analyse` wrote that
 * column, `crawl_metrics.orphans` counted exactly these rows, and a second
 * implementation of the rule here is how a report comes to disagree with the metrics row
 * it prints beside (see `orphanListProblem` in packages/cli).
 */
export async function listOrphanFindings(
  db: Queryable,
  crawlId: number,
): Promise<OrphanFinding[]> {
  const { rows } = await db.query<OrphanFinding>(
    `SELECT url_normalized AS "urlNormalized", class, post_type AS "postType",
            status_code AS "statusCode"
     FROM pages WHERE crawl_id = $1 AND class = 'orphan'
     ORDER BY url_normalized`,
    [crawlId],
  );
  return rows;
}

export interface BrokenLinkFinding {
  /** The link's **target** — the subject of a `broken_internal_link` review. */
  readonly urlNormalized: string;
  readonly statusCode: number;
  /** Distinct pages of this crawl linking to it (PRD §2, blast radius). */
  readonly blastRadius: number;
}

/**
 * Internal links whose target served an error, one row per target, worst first (PRD §9:
 * "broken links by blast radius").
 *
 * **Blast radius is distinct source pages, and `crawl_metrics.broken` is edges.** The
 * two are not the same number and neither is wrong: measured on the 403bplan.net
 * fixture, `/contact-us/` is linked by **15 edges from 13 distinct pages** — the header
 * nav on all 13, plus an in-content link on two of them. PRD §2 defines blast radius as
 * "the number of distinct pages linking to it", which is the number a person acts on;
 * `broken` counts every edge, which is what step 4 measured. A report printing one under
 * the other's name is the kind of quiet disagreement `reportProblem` exists to catch, so
 * they are labelled apart where they are printed.
 *
 * The error test is `countAnalysedLinks`' own `broken` filter, imported rather than
 * restated (`BROKEN_INTERNAL_EDGE`): a target the crawl never fetched is
 * `internalUnresolved` — unknown, never broken (`005_analysis.sql`).
 */
export async function listBrokenLinkFindings(
  db: Queryable,
  crawlId: number,
): Promise<BrokenLinkFinding[]> {
  const { rows } = await db.query<BrokenLinkFinding>(
    `SELECT t.url_normalized AS "urlNormalized", t.status_code AS "statusCode",
            count(DISTINCT l.from_page_id)::int AS "blastRadius"
     FROM links l
     JOIN pages t ON t.crawl_id = l.crawl_id AND t.id = l.to_page_id
     WHERE l.crawl_id = $1 AND ${BROKEN_INTERNAL_EDGE}
     GROUP BY t.url_normalized, t.status_code
     ORDER BY count(DISTINCT l.from_page_id) DESC, t.url_normalized`,
    [crawlId],
  );
  return rows;
}
