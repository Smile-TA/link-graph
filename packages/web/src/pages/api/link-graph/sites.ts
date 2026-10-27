/**
 * `GET /api/link-graph/sites` — the pack's `getLinkGraphSites`: every site with its latest
 * complete production capture. Served from `@link-graph/db`, read-only.
 */
import type { APIRoute } from "astro";
import { getCatalog } from "../../../server/captures";

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    return Response.json(await getCatalog(), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "The database is unavailable. Please retry." },
      { status: 503 },
    );
  }
};
