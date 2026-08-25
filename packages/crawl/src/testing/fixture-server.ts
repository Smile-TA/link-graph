/**
 * A local HTTP server that answers as the estate answers, for the integration tier.
 *
 * **Why the crawler is never pointed at the estate.** Wordfence bans the source IP for
 * an hour on the first 503 (PRD §5.1), so a suite that crawled a real host would be a
 * suite nobody could run twice. Everything the crawler needs to be exercised against —
 * a redirect chain, a 404, a canonicalized duplicate, an alias hop, a rate-limit 503
 * that later recovers — is a *server behaviour*, and each one used here is one measured
 * on this estate and cited at its call site. The bodies are the checked-in production
 * captures, byte for byte.
 *
 * **Why the fetcher is rewritten rather than the URLs.** Node identity is
 * `https://403bplan.net/…` and it has to stay that, or the crawl would store a
 * different graph than the real one: `normalizeUrl` forces internal URLs to https, so a
 * site whose canonical host was `127.0.0.1` could not be served over plain HTTP at all.
 * So the site keeps its real host and only the *connection* is redirected, one local
 * server per host. What that gives up is TLS and DNS, which is what the one live test in
 * `packages/truth` covers; what it keeps is a real socket, real status lines, real
 * headers and real redirects.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpFetcher, type CrawlFetcher, type FetchResult } from "../fetcher.js";

export interface FixtureResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** What a host answers for a path (`/about/?x=1`, exactly as requested). */
export type FixtureHandler = (path: string) => FixtureResponse;

export interface FixtureServer {
  /** A fetcher for the crawler: real HTTP, aimed at these servers. */
  readonly fetcher: CrawlFetcher;
  /** Every request received, as `host + path`, in the order they arrived. */
  readonly requests: readonly string[];
  /** The local origin standing in for a host, for tests that fetch one directly. */
  originFor(host: string): string;
  close(): Promise<void>;
}

export async function startFixtureServer(
  hosts: Readonly<Record<string, FixtureHandler>>,
): Promise<FixtureServer> {
  const requests: string[] = [];
  const origins = new Map<string, string>();
  const servers: Server[] = [];

  for (const [host, handler] of Object.entries(hosts)) {
    const server = createServer((request, response) => {
      const path = request.url ?? "/";
      requests.push(`${host}${path}`);
      const answer = handler(path);
      response.writeHead(answer.status, answer.headers ?? {});
      response.end(answer.body ?? "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    origins.set(host, `http://127.0.0.1:${address.port}`);
    servers.push(server);
  }

  const real = createHttpFetcher();
  return {
    requests,
    originFor(host: string): string {
      const origin = origins.get(host);
      if (origin === undefined) throw new Error(`fixture server has no host ${host}`);
      return origin;
    },
    fetcher: {
      get(url: string): Promise<FetchResult> {
        const target = new URL(url);
        const origin = origins.get(target.host);
        if (origin === undefined) {
          // Never a transport error: a crawl asking for a host the scenario did not
          // declare is a bug in the test, and returning "the host is down" would let it
          // pass as a partial crawl.
          throw new Error(`fixture server has no host ${target.host} (for ${url})`);
        }
        return real.get(`${origin}${target.pathname}${target.search}`);
      },
    },
    async close(): Promise<void> {
      await real.close?.();
      await Promise.all(
        servers.map((server) => {
          // `close()` alone waits for every idle keep-alive socket to time out, which
          // undici holds open for seconds after the crawl has finished — measured as
          // ~3s of dead time per test before this line existed.
          server.closeAllConnections();
          return new Promise<void>((resolve) => server.close(() => resolve()));
        }),
      );
    },
  };
}
