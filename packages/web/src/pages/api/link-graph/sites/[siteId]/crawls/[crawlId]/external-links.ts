/**
 * `GET /api/link-graph/sites/:siteId/crawls/:crawlId/external-links` — the pack's
 * `getLinkGraphExternalLinks`: complete grouped external link evidence for the capture, or
 * the focus page's neighbourhood. Recorded evidence only; nothing is checked live, and a
 * failure is a 503, never an empty list that would read as "no external links".
 */
import { listGraphExternalLinks } from "@link-graph/db";
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
    return Response.json(await listGraphExternalLinks(pool, crawl, scope), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Could not load recorded external links. Please retry." },
      { status: 503 },
    );
  }
};
