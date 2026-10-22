/**
 * `GET /api/link-graph/sites/:siteId` — the pack's `getLinkGraphSnapshot`: one site's
 * latest capture. `includeEdges=false` leaves the edge list out (the pack's pages fetch it
 * on demand); `crawlId` pins the capture the caller expects and answers 409 when a newer
 * one has landed since.
 */
import { listGraphConnections } from "@link-graph/db";
import type { APIRoute } from "astro";
import { pool } from "../../../../db";
import { getCatalog, getSnapshot } from "../../../../server/captures";

export const prerender = false;

export const GET: APIRoute = async ({ params, url }) => {
  const { siteId } = params;
  if (siteId === undefined)
    return Response.json({ error: "Missing site" }, { status: 400 });
  const includeEdges = url.searchParams.get("includeEdges");
  const crawlId = url.searchParams.get("crawlId");
  if (
    (includeEdges !== null && includeEdges !== "true" && includeEdges !== "false") ||
    (crawlId !== null && !/^[1-9]\d{0,17}$/.test(crawlId))
  ) {
    return Response.json({ error: "Invalid capture request" }, { status: 400 });
  }
  try {
    const site = (await getCatalog()).find((row) => row.siteId === siteId);
    if (site === undefined)
      return Response.json({ error: "Site not found" }, { status: 404 });
    if (crawlId !== null && crawlId !== site.crawlId) {
      return Response.json(
        { error: "The latest capture changed. Refresh the sites catalog." },
        { status: 409 },
      );
    }
    const snapshot = await getSnapshot(siteId);
    const edges =
      includeEdges === "false" || site.crawlId === null
        ? []
        : await listGraphConnections(pool, Number(site.crawlId));
    return Response.json(
      { ...snapshot, edges },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Could not load this site's capture. Please retry." },
      { status: 503 },
    );
  }
};
