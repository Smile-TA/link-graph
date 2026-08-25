/** `links` — the edges of one crawl's graph (PRD §7). */
import type { LinkContainer } from "@link-graph/core";
import type { Queryable } from "../pool.js";

export interface LinkInput {
  readonly fromPageId: number;
  readonly toUrlNormalized: string;
  /** The page in this crawl the target names, or `null` if the crawl has no such page. */
  readonly toPageId: number | null;
  readonly anchor: string;
  readonly rel: string | null;
  readonly isExternal: boolean;
  /** `null` until analyse marks it (step 4). Never defaulted to false. */
  readonly isBoilerplate: boolean | null;
  readonly container: LinkContainer;
  readonly domIndex: number;
}

export interface LinkRow extends LinkInput {
  readonly id: number;
  readonly crawlId: number;
}

const COLUMNS = `id, crawl_id AS "crawlId", from_page_id AS "fromPageId",
  to_url_normalized AS "toUrlNormalized", to_page_id AS "toPageId", anchor, rel,
  is_external AS "isExternal", is_boilerplate AS "isBoilerplate", container,
  dom_index AS "domIndex"`;

/**
 * Insert every edge of a crawl in one statement. As with `insertPages`, no
 * `ON CONFLICT`: a collision means the caller built two edges with the same DOM
 * position, and dropping one would quietly change an inbound count.
 *
 * One statement per call, not one statement per crawl: a 3,000-page site is on the
 * order of 600k edges, and the crawler (step 6) will have to feed this in batches or
 * switch to COPY. Nothing at this scale does yet, so the batching is not written.
 */
export async function insertLinks(
  db: Queryable,
  crawlId: number,
  links: readonly LinkInput[],
): Promise<number> {
  if (links.length === 0) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO links (crawl_id, from_page_id, to_url_normalized, to_page_id, anchor,
                        rel, is_external, is_boilerplate, container, dom_index)
     SELECT $1, u.from_page_id, u.to_url, u.to_page_id, u.anchor, u.rel, u.is_external,
            u.is_boilerplate, u.container, u.dom_index
     FROM unnest($2::bigint[], $3::text[], $4::bigint[], $5::text[], $6::text[],
                 $7::boolean[], $8::boolean[], $9::text[], $10::integer[])
       AS u(from_page_id, to_url, to_page_id, anchor, rel, is_external,
            is_boilerplate, container, dom_index)`,
    [
      crawlId,
      links.map((l) => l.fromPageId),
      links.map((l) => l.toUrlNormalized),
      links.map((l) => l.toPageId),
      links.map((l) => l.anchor),
      links.map((l) => l.rel),
      links.map((l) => l.isExternal),
      links.map((l) => l.isBoilerplate),
      links.map((l) => l.container),
      links.map((l) => l.domIndex),
    ],
  );
  if (rowCount !== links.length) {
    throw new Error(
      `insertLinks wrote ${String(rowCount)} of ${links.length} links for crawl ${crawlId}`,
    );
  }
  return rowCount;
}

export async function listLinks(db: Queryable, crawlId: number): Promise<LinkRow[]> {
  const { rows } = await db.query<LinkRow>(
    `SELECT ${COLUMNS} FROM links WHERE crawl_id = $1
     ORDER BY from_page_id, dom_index`,
    [crawlId],
  );
  return rows;
}

/**
 * Point every internal edge at the page row its target names, where this crawl has one.
 *
 * Run once at the end of a crawl rather than at insert time: a page is linked to long
 * before it is fetched — step 3 measured 439 of 452 internal edges pointing at targets
 * that were not yet rows — so resolving on insert would leave most of the graph
 * permanently unjoined and every one of those pages looking like an orphan.
 *
 * Idempotent, so a resumed crawl can run it again. Returns the number of edges it
 * joined.
 */
export async function resolveLinkTargets(
  db: Queryable,
  crawlId: number,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE links l SET to_page_id = p.id
     FROM pages p
     WHERE l.crawl_id = $1 AND l.to_page_id IS NULL AND NOT l.is_external
       AND p.crawl_id = l.crawl_id AND p.url_normalized = l.to_url_normalized`,
    [crawlId],
  );
  return rowCount ?? 0;
}
