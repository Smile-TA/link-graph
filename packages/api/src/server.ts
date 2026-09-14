/**
 * Read-only HTTP over Postgres (step 11). Three routes, all GET, none of which write:
 * the registry list, one site, and the same report `link-graph report` prints — as JSON
 * instead of text, over `runReportCommand` rather than a second query path.
 *
 * `node:http` and a manual switch rather than a framework: three routes do not need a
 * router, and this is the first HTTP server in the repo, so there is no existing
 * convention a dependency would need to match.
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { listSites, findSiteBySlug } from "@link-graph/db";
import { runReportCommand, UsageError } from "@link-graph/cli";
import type { Pool } from "pg";

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

export function createServer(pool: Pool): Server {
  return createHttpServer((req, res) => {
    void handle(pool, req, res).catch((error: unknown) => {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
}

async function handle(pool: Pool, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  // A `//` anywhere but the path's very ends (`/sites//report`, `/sites/`) produces an
  // empty segment once split; `.filter(Boolean)` would silently drop it and reroute the
  // request to a shorter route instead of 404ing on the malformed path.
  if (/\/\//.test(url.pathname)) return send(res, 404, { error: `no route for ${url.pathname}` });
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method !== "GET") return send(res, 405, { error: "only GET is supported" });

  if (parts.length === 1 && parts[0] === "sites") {
    return send(res, 200, await listSites(pool));
  }

  if (parts.length === 2 && parts[0] === "sites") {
    const site = await findSiteBySlug(pool, decodeURIComponent(parts[1] ?? ""));
    if (site === null) return send(res, 404, { error: `no site ${parts[1]}` });
    return send(res, 200, site);
  }

  if (parts.length === 3 && parts[0] === "sites" && parts[2] === "report") {
    try {
      const report = await runReportCommand(pool, decodeURIComponent(parts[1] ?? ""));
      return send(res, 200, report);
    } catch (error) {
      if (error instanceof UsageError) return send(res, 404, { error: error.message });
      // A known site with nothing reportable yet (no complete crawl, no metrics row,
      // or a two-numbers-for-one-question refusal) — a real fact about the site's
      // state, not a server failure.
      const message = error instanceof Error ? error.message : String(error);
      return send(res, 409, { error: message });
    }
  }

  return send(res, 404, { error: `no route for ${url.pathname}` });
}
