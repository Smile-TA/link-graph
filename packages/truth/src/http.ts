/**
 * The one I/O seam of this package (engineering guide §4.2): a single HTTP GET.
 *
 * Two contracts that the resolver depends on and that a substitute must honour:
 *
 * - **A transport failure is data, not an exception.** `agents.integrity.com` has no
 *   DNS and `integritymedicarehelpline.com` refuses connections (PRD §3.1), and both
 *   are facts the resolver has to report differently from "this site has no truth
 *   source". Returning them as a value is what stops a `catch` from flattening the two.
 * - **Redirects are not followed here.** `agent.familyfirstlife.com/sitemap.xml` 301s to
 *   `/wp-sitemap.xml`, and a sitemap that redirects off-site would otherwise pull
 *   another host's inventory into this site's truth source without anyone seeing it. The
 *   resolver follows a hop deliberately, checks where it lands, and records it.
 */

export interface HttpResponse {
  readonly kind: "response";
  readonly status: number;
  /** Header names lowercased, as both `fetch` and the recorded fixtures store them. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type HttpResult =
  HttpResponse | { readonly kind: "transport-error"; readonly detail: string };

export interface TruthDeps {
  readonly get: (url: string) => Promise<HttpResult>;
}

/**
 * Minimum gap between requests. Wordfence returns 503 above ~8 req/s sustained and bans
 * the source IP for an hour (PRD §5.1, measured). Not configurable: no caller needs a
 * different rate, and the per-host limiter that will replace this arrives with the
 * crawler's `bottleneck` in step 6.
 */
const MIN_INTERVAL_MS = 1000;

/**
 * The real fetcher. Sequential and self-paced: `resolveTruthSource` awaits every
 * request, so keeping the last-request timestamp here is all the rate limiting a truth
 * resolution needs.
 */
export function createHttpFetcher(): TruthDeps {
  let last = 0;
  return {
    async get(url: string): Promise<HttpResult> {
      const wait = last + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      last = Date.now();
      try {
        const response = await fetch(url, { redirect: "manual" });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
        return {
          kind: "response",
          status: response.status,
          headers,
          body: await response.text(),
        };
      } catch (error) {
        // undici reports DNS and connection failures as a TypeError whose own message
        // is just "fetch failed"; the code lives on `cause`. Losing it would make a
        // dead host indistinguishable from a slow one in the finding we write.
        const cause = (error as { cause?: { code?: string } }).cause?.code;
        const message = error instanceof Error ? error.message : String(error);
        return {
          kind: "transport-error",
          detail: cause === undefined ? message : `${message}: ${cause}`,
        };
      }
    },
  };
}
