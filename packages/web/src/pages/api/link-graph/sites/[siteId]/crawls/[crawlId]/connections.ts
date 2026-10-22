/**
 * `GET /api/link-graph/sites/:siteId/crawls/:crawlId/connections` — the pack's
 * `getLinkGraphConnections`: internal edges grouped losslessly, endpoints as positions in
 * the capture's pages (ordered by path, then id). `path`+`hops` returns the focus page's
 * all-direction neighbourhood instead of the whole capture.
 */
import { listGraphConnections } from "@link-graph/db";
import type { APIRoute } from "astro";
import { pool } from "../../../../../../../db";
import { parseScope, pinnedCrawl } from "../../../../../../../server/graph-api";

export const prerender = false;

export const GET: APIRoute = async ({ params, url }) => {
  const crawl = await pinnedCrawl(params.siteId, params.crawlId);
  if (crawl instanceof Response) return crawl;
  const scope = parseScope(url.searchParams);
  if (scope instanceof Response) return scope;
  try {
    return Response.json(await listGraphConnections(pool, crawl, scope), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Could not load graph connections. Please retry." },
      { status: 503 },
    );
  }
};
