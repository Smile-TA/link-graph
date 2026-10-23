/**
 * The read-only graph queries behind the dashboard's page network, section matrix and
 * broken-link list (the Link Graph PR pack's API contract, served by `packages/web`).
 *
 * Nothing here writes. Every query reads rows `crawl` and `analyse` already committed and
 * restates no definition of its own: "broken" is `BROKEN_INTERNAL_EDGE`
 * (`repo/analysis.ts`), the one predicate `crawl_metrics.broken` and the report's broken
 * list both use, so the dashboard's number, the report's and this list can never drift.
 *
 * **Page positions.** A graph edge names its endpoints by *position* — the index of the
 * page in `listGraphPages`'s order (`path`, then `id`) — not by id, which keeps the edge
 * list small enough to ship to a browser. `listGraphEdges` and `listGraphConnections`
 * number pages with the same ordering, so a position means the same page in all three.
 */
import { BROKEN_INTERNAL_EDGE } from "./analysis.js";
import type { Queryable } from "../pool.js";

export interface GraphPage {
  readonly url: string;
  readonly path: string;
  readonly statusCode: number | null;
  /** `unclassified` when `analyse` has not classified the page — never a guess. */
  readonly pageClass: string;
  readonly depth: number | null;
  readonly indexable: boolean;
  readonly inTruthSource: boolean;
  readonly postType: string | null;
  /** Distinct internal pages linking here, self-links excluded. */
  readonly inboundCount: number;
  /** Distinct internal pages linked to, self-links excluded. */
  readonly outboundCount: number;
}

/** Every page of a crawl in the order edge positions refer to. */
export async function listGraphPages(
  db: Queryable,
  crawlId: number,
): Promise<GraphPage[]> {
  const { rows } = await db.query<GraphPage>(
    `WITH inbound AS (
       SELECT to_page_id, count(DISTINCT from_page_id)::int AS n FROM links
       WHERE crawl_id = $1 AND NOT is_external AND to_page_id IS NOT NULL
         AND from_page_id <> to_page_id
       GROUP BY to_page_id
     ), outbound AS (
       SELECT from_page_id, count(DISTINCT to_page_id)::int AS n FROM links
       WHERE crawl_id = $1 AND NOT is_external AND to_page_id IS NOT NULL
         AND from_page_id <> to_page_id
       GROUP BY from_page_id
     )
     SELECT p.url_normalized AS url, p.path, p.status_code AS "statusCode",
            COALESCE(p.class, 'unclassified') AS "pageClass", p.depth, p.indexable,
            p.in_truth_source AS "inTruthSource", p.post_type AS "postType",
            COALESCE(i.n, 0) AS "inboundCount", COALESCE(o.n, 0) AS "outboundCount"
     FROM pages p
     LEFT JOIN inbound i ON i.to_page_id = p.id
     LEFT JOIN outbound o ON o.from_page_id = p.id
     WHERE p.crawl_id = $1
     ORDER BY p.path, p.id`,
    [crawlId],
  );
  return rows;
}

export interface GraphEdge {
  /** Position in `listGraphPages`. */
  readonly from: number;
  readonly to: number;
  readonly anchor: string;
  readonly container: string;
  readonly isBoilerplate: boolean | null;
  /** How many recorded link rows this group stands for. */
  readonly count: number;
}

/** A focus page and how far out to walk, for the neighbourhood-scoped queries. */
export interface GraphScope {
  readonly path: string;
  readonly hops: 1 | 2;
}

/**
 * All-direction neighbourhood of a path: every page within `$3` hops over internal edges,
 * either direction. `$1` = crawl, `$2` = path, `$3` = hops. External destinations never
 * expand the frontier — an external URL has no page row to walk on from.
 */
const NEIGHBORHOOD = `
  WITH RECURSIVE reach(id, depth) AS (
    SELECT id, 0 FROM pages WHERE crawl_id = $1 AND path = $2
    UNION
    SELECT neighbor.id, r.depth + 1 FROM reach r
    CROSS JOIN LATERAL (
      SELECT to_page_id AS id FROM links
      WHERE crawl_id = $1 AND NOT is_external AND from_page_id = r.id AND to_page_id IS NOT NULL
      UNION
      SELECT from_page_id AS id FROM links
      WHERE crawl_id = $1 AND NOT is_external AND to_page_id = r.id
    ) neighbor
    WHERE r.depth < $3
  ), neighborhood AS (
    SELECT id, min(depth) AS depth FROM reach GROUP BY id
  )`;

/**
 * Internal edges grouped by (source, target, anchor, landmark, boilerplate flag) — the
 * lossless form the page network and section matrix draw from. Whole crawl, or the
 * focus page's neighbourhood: a complete all-direction superset, so a client can derive
 * any direction or hop count from it without a second request.
 */
export async function listGraphConnections(
  db: Queryable,
  crawlId: number,
  scope?: GraphScope,
): Promise<GraphEdge[]> {
  const numbered = `numbered AS (
    SELECT id, (row_number() OVER (ORDER BY path, id) - 1)::int AS position
    FROM pages WHERE crawl_id = $1
  )`;
  const select = `
    SELECT f.position AS "from", t.position AS "to", l.anchor, l.container,
           l.is_boilerplate AS "isBoilerplate", count(*)::int AS count
    FROM links l
    JOIN numbered f ON f.id = l.from_page_id
    JOIN numbered t ON t.id = l.to_page_id
    WHERE l.crawl_id = $1 AND NOT l.is_external AND l.from_page_id <> l.to_page_id`;
  if (scope === undefined) {
    const { rows } = await db.query<GraphEdge>(
      `WITH ${numbered} ${select}
       GROUP BY f.position, t.position, l.anchor, l.container, l.is_boilerplate`,
      [crawlId],
    );
    return rows;
  }
  const { rows } = await db.query<GraphEdge>(
    `${NEIGHBORHOOD}, ${numbered} ${select}
       AND l.from_page_id IN (SELECT id FROM neighborhood)
       AND l.to_page_id IN (SELECT id FROM neighborhood)
       AND ($3 = 2 OR l.from_page_id IN (SELECT id FROM pages WHERE crawl_id = $1 AND path = $2)
                   OR l.to_page_id IN (SELECT id FROM pages WHERE crawl_id = $1 AND path = $2))
     GROUP BY f.position, t.position, l.anchor, l.container, l.is_boilerplate`,
    [crawlId, scope.path, scope.hops],
  );
  return rows;
}

/**
 * What the shared external link check (`external_urls`) concluded about a destination:
 * `broken` is a confirmed 404/410, `unverified` is a response that says nothing about the
 * link (a third party's bot protection, a timeout), `ok` answered, and `null` was never
 * checked. Only `broken` may be drawn as a defect.
 */
export type ExternalCheck = "broken" | "unverified" | "ok" | null;

/**
 * The linkcheck verdict's "resource is absent" rule (`RESOURCE_IS_ABSENT` in
 * `packages/linkcheck/src/verdict.ts`), narrower than the internal `status_code >= 400`
 * on purpose: for a third party a 403 is a fact about their WAF, not about the link.
 * Kept here, not imported, because `db` sits below `linkcheck`.
 */
export const BROKEN_EXTERNAL_URL = `x.status_code IN (404, 410) AND NOT x.unverified`;

const EXTERNAL_CHECK = `CASE
  WHEN x.last_checked IS NULL THEN NULL
  WHEN ${BROKEN_EXTERNAL_URL} THEN 'broken'
  WHEN x.unverified THEN 'unverified'
  ELSE 'ok' END`;

export interface GraphExternalLink {
  readonly fromUrl: string;
  readonly toUrl: string;
  readonly anchor: string;
  readonly container: string;
  readonly isBoilerplate: boolean | null;
  readonly count: number;
  readonly externalCheck: ExternalCheck;
  /** The status the check recorded; `null` when none got that far. */
  readonly externalStatusCode: number | null;
}

/**
 * Recorded external link evidence, grouped, from internal pages — whole crawl or the
 * focus page's neighbourhood. Complete: no pagination, no search, no node limit, so a
 * client can count distinct destinations and domains before it applies any rendering cap.
 * Recorded evidence only: nothing here checks a URL.
 */
export async function listGraphExternalLinks(
  db: Queryable,
  crawlId: number,
  scope?: GraphScope,
): Promise<GraphExternalLink[]> {
  const columns = `
    SELECT p.url_normalized AS "fromUrl", l.to_url_normalized AS "toUrl", l.anchor,
           l.container, l.is_boilerplate AS "isBoilerplate", count(*)::int AS count,
           ${EXTERNAL_CHECK} AS "externalCheck", x.status_code AS "externalStatusCode"
    FROM links l JOIN pages p ON p.crawl_id = l.crawl_id AND p.id = l.from_page_id
    LEFT JOIN external_urls x ON x.url_normalized = l.to_url_normalized
    WHERE l.crawl_id = $1 AND l.is_external`;
  const grouping = `
    GROUP BY p.url_normalized, l.to_url_normalized, l.anchor, l.container, l.is_boilerplate,
             x.last_checked, x.status_code, x.unverified
    ORDER BY p.url_normalized, l.to_url_normalized, l.anchor, l.container, l.is_boilerplate`;
  if (scope === undefined) {
    const { rows } = await db.query<GraphExternalLink>(`${columns} ${grouping}`, [
      crawlId,
    ]);
    return rows;
  }
  const { rows } = await db.query<GraphExternalLink>(
    `${NEIGHBORHOOD} ${columns}
       AND l.from_page_id IN (SELECT id FROM neighborhood)
       AND (
         l.from_page_id IN (SELECT id FROM neighborhood WHERE depth < $3)
         OR ($3 = 2 AND (
           l.to_url_normalized IN (
             SELECT e.to_url_normalized FROM links e
             WHERE e.crawl_id = $1 AND e.is_external
               AND e.from_page_id IN (SELECT id FROM neighborhood WHERE depth < $3)
           )
           OR l.to_url_normalized IN (
             SELECT url_normalized FROM pages
             WHERE id IN (SELECT id FROM neighborhood) AND crawl_id = $1
           )
         ))
       )
     ${grouping}`,
    [crawlId, scope.path, scope.hops],
  );
  return rows;
}

/**
 * Every external link whose destination the link check confirmed gone
 * (`BROKEN_EXTERNAL_URL`). A separate list from the internal one: the two definitions are
 * deliberately different, so their counts are never added together.
 */
export async function listGraphBrokenExternalLinks(
  db: Queryable,
  crawlId: number,
): Promise<GraphBrokenEdge[]> {
  const { rows } = await db.query<GraphBrokenEdge>(
    `SELECT f.url_normalized AS "fromUrl", l.to_url_normalized AS "toUrl",
            x.status_code AS "statusCode", l.anchor
     FROM links l
     JOIN pages f ON f.crawl_id = l.crawl_id AND f.id = l.from_page_id
     JOIN external_urls x ON x.url_normalized = l.to_url_normalized
     WHERE l.crawl_id = $1 AND l.is_external AND ${BROKEN_EXTERNAL_URL}
     ORDER BY l.id`,
    [crawlId],
  );
  return rows;
}

export interface GraphBrokenEdge {
  readonly fromUrl: string;
  readonly toUrl: string;
  readonly statusCode: number;
  readonly anchor: string;
}

/**
 * Every broken internal edge — `BROKEN_INTERNAL_EDGE`, so exactly the edges
 * `crawl_metrics.broken` counted: an internal link to a page this crawl fetched that
 * served `>= 400`. A target the crawl never fetched has no status and is *unresolved*,
 * which is unknown, never broken.
 */
export async function listGraphBrokenEdges(
  db: Queryable,
  crawlId: number,
): Promise<GraphBrokenEdge[]> {
  const { rows } = await db.query<GraphBrokenEdge>(
    `SELECT f.url_normalized AS "fromUrl", t.url_normalized AS "toUrl",
            t.status_code AS "statusCode", l.anchor
     FROM links l
     JOIN pages f ON f.crawl_id = l.crawl_id AND f.id = l.from_page_id
     JOIN pages t ON t.crawl_id = l.crawl_id AND t.id = l.to_page_id
     WHERE l.crawl_id = $1 AND ${BROKEN_INTERNAL_EDGE}
     ORDER BY l.id`,
    [crawlId],
  );
  return rows;
}

/**
 * Link-row totals for a set of crawls, one query. A complete crawl's rows never change,
 * so callers cache the answer per crawl id; crawls with no rows are absent.
 */
export async function countLinksPerCrawl(
  db: Queryable,
  crawlIds: readonly number[],
): Promise<Map<number, number>> {
  if (crawlIds.length === 0) return new Map();
  const { rows } = await db.query<{ crawlId: string; n: number }>(
    `SELECT crawl_id::text AS "crawlId", count(*)::int AS n FROM links
     WHERE crawl_id = ANY($1::bigint[]) GROUP BY crawl_id`,
    [crawlIds],
  );
  return new Map(rows.map((row) => [Number(row.crawlId), row.n]));
}
