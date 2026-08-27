/**
 * One page's rows, written as one transaction.
 *
 * The page, its edges, the URLs it discovered and the frontier entry it closes go in
 * together or not at all. Any split is a way for a killed worker to leave a page with no
 * edges, or a frontier that owes a page already written — and the crawl would then
 * either double the page (rejected by `UNIQUE (crawl_id, url_normalized)`, mid-crawl) or
 * report a page nothing links out of.
 */
import {
  addToFrontier,
  insertLinks,
  insertPages,
  markFrontierFetched,
  withTransaction,
} from "@link-graph/db";
import type { Pool } from "pg";
import type { PageRecord } from "./record.js";

export async function writePage(
  pool: Pool,
  crawlId: number,
  record: PageRecord,
  at: Date,
): Promise<void> {
  const url = record.page.urlNormalized;
  await withTransaction(pool, async (tx) => {
    const [inserted] = await insertPages(tx, crawlId, [record.page]);
    if (inserted === undefined) throw new Error(`crawl: no page row written for ${url}`);
    await insertLinks(
      tx,
      crawlId,
      record.links.map((link) => ({
        ...link,
        fromPageId: inserted.id,
        // Resolved once at the end of the crawl: a page is linked to long before it is
        // fetched — step 3 measured 439 of 452 internal edges pointing at targets that
        // were not yet rows — so resolving here would leave most of the graph unjoined.
        toPageId: null,
      })),
    );
    // On a sampled crawl these are URLs the ceiling guarantees will never be fetched.
    // They are queued anyway, deliberately: the frontier is then the record of what the
    // sample skipped, which is the only place that fact exists.
    await addToFrontier(
      tx,
      crawlId,
      record.discovered.map((discovered) => ({
        urlNormalized: discovered,
        inTruthSource: false,
        // Nothing named a post type for a URL the crawl found by following a link; the
        // truth source is the only thing that ever does, and null stays "unknown".
        postType: null,
      })),
    );
    await markFrontierFetched(tx, crawlId, url, at);
  });
}
