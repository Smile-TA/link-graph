/**
 * What the two `crawls/:crawlId/*` endpoints share: the capture must be the one the
 * catalog calls this site's latest — a crawl id from another site, or a stale one, is
 * refused rather than answered — and the optional focus-page scope.
 */
import type { GraphScope } from "@link-graph/db";
import { getCatalog } from "./captures";

const CRAWL_ID = /^[1-9]\d{0,17}$/;

/** The numeric crawl id when `crawlId` is this site's latest capture, else a `Response`. */
export async function pinnedCrawl(
  siteId: string | undefined,
  crawlId: string | undefined,
): Promise<number | Response> {
  if (siteId === undefined || crawlId === undefined || !CRAWL_ID.test(crawlId)) {
    return Response.json({ error: "Invalid crawl identifier" }, { status: 400 });
  }
  try {
    const site = (await getCatalog()).find((row) => row.siteId === siteId);
    if (site === undefined || site.crawlId !== crawlId) {
      return Response.json({ error: "Capture not found for this site" }, { status: 404 });
    }
    return Number(crawlId);
  } catch {
    return Response.json(
      { error: "The database is unavailable. Please retry." },
      { status: 503 },
    );
  }
}

/** `undefined` for the whole capture; a `Response` for a malformed scope. */
export function parseScope(query: URLSearchParams): GraphScope | undefined | Response {
  const path = query.get("path");
  const hops = query.get("hops");
  if (path === null && hops === null) return undefined;
  if (
    path === null ||
    path.length > 8192 ||
    (hops !== null && hops !== "1" && hops !== "2")
  ) {
    return Response.json({ error: "Invalid network neighborhood" }, { status: 400 });
  }
  return { path, hops: hops === "2" ? 2 : 1 };
}
