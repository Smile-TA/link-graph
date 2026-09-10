/**
 * The crawler's one I/O seam (engineering guide §4.2): a single HTTP GET.
 *
 * The contracts a substitute must honour are the same two `packages/truth`'s fetcher
 * states, for the same reasons:
 *
 * - **A transport failure is data, not an exception.** `agents.integrity.com` has no DNS
 *   and `integritymedicarehelpline.com` refuses connections (PRD §3.1). A `catch` around
 *   the whole crawl would flatten those into "this page has no links", which is the
 *   shape of a page nobody links out of.
 * - **Redirects are never followed here.** Which redirect is an alias hop to follow and
 *   which is a `pages.redirect_to` to record is a decision that needs the site's alias
 *   set (PRD §5.1), and it is made in `fetch-page.ts` where that set is in scope.
 */
import { Agent, request } from "undici";
import { USER_AGENT } from "@link-graph/core";
import { isHtmlContentType } from "./record.js";

export interface FetchResponse {
  readonly kind: "response";
  readonly status: number;
  /** Names lowercased; a repeated header is joined with ", " as undici joins it. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type FetchResult =
  FetchResponse | { readonly kind: "transport-error"; readonly detail: string };

export interface CrawlFetcher {
  get(url: string): Promise<FetchResult>;
  /** Releases pooled connections. Absent on a fake, which has none to release. */
  close?(): Promise<void>;
}

/**
 * The request headers, measured rather than assumed.
 *
 * Verified 2026-08-24 with one GET of `https://403bplan.net/terms-of-service/`: this
 * exact set answers 200 with `text/html; charset=UTF-8`, no `content-encoding`, and
 * 47,219 bytes of the page. So a named user-agent is not blocked by Wordfence, and
 * `identity` is honoured.
 *
 * `undici.request` follows no redirects unless a redirect interceptor is installed, and
 * none is: the redirect decision needs the site's alias set and belongs to
 * `fetch-page.ts`. Asserted rather than assumed — `crawl.int.test.ts` fetches a 301 from
 * the fixture server through this function and gets the 301 back.
 *
 * **Why `identity` rather than gzip.** `undici.request` does no content-decoding of its
 * own, so accepting a compressed body would mean decoding it here or handing cheerio
 * bytes — and a page parsed from bytes yields zero links, which reads downstream as a
 * leaf page rather than as a failure. At 1 req/s the bandwidth saved is worth nothing
 * against that. `recordPage` refuses a compressed body anyway, so a server that ignores
 * this is loud rather than silent.
 */
const HEADERS: Readonly<Record<string, string>> = {
  "user-agent": USER_AGENT,
  accept: "text/html,application/xhtml+xml,*/*",
  "accept-encoding": "identity",
};

/**
 * Nothing has measured how slow this estate's slowest page is, so this is a bound
 * rather than a tuned value: a crawl of 3,000 pages that hangs on one of them is a crawl
 * that never finishes and never says why, and 30s is far past any page CloudFront has
 * been observed serving.
 */
const TIMEOUT_MS = 30_000;

/**
 * **This fetcher owns its connection pool rather than using undici's process-global
 * dispatcher, and that is a measured decision, not tidiness.** Measured 2026-08-24
 * against a local server: 10 sequential requests issued from inside a `bottleneck` task
 * take **2.0s** through the global dispatcher and **75ms** through an `Agent` created
 * here. Both reuse a single TCP connection, and the same 10 requests outside a
 * bottleneck task are fast on either — so it is the combination, roughly 200ms of
 * latency per request, and this crawler is exactly that combination. At the estate's
 * 1 req/s it would hide inside the gap between requests and cost eight minutes of a
 * 33-hour crawl with nothing to show for it.
 *
 * PRD §5.0 chose undici for "pooling, keep-alive"; this is that pool, held explicitly.
 */
export function createHttpFetcher(): CrawlFetcher {
  // One connection per origin, because the limiter allows one request per host at a time
  // anyway (PRD §5.1) and a second socket would only be a second way to be noticed by
  // Wordfence.
  const dispatcher = new Agent({ connections: 1 });
  return {
    async close(): Promise<void> {
      await dispatcher.close();
    },
    async get(url: string): Promise<FetchResult> {
      try {
        const response = await request(url, {
          method: "GET",
          dispatcher,
          headers: HEADERS,
          headersTimeout: TIMEOUT_MS,
          bodyTimeout: TIMEOUT_MS,
        });
        const headers = flatten(response.headers);
        return {
          kind: "response",
          status: response.statusCode,
          headers,
          body: await readBody(response, headers),
        };
      } catch (error) {
        // undici reports DNS and connection failures with the code on `cause`; losing it
        // makes a dead host indistinguishable from a slow one in the row we write.
        const cause = (error as { cause?: { code?: string } }).cause?.code;
        const code = (error as { code?: string }).code;
        const message = error instanceof Error ? error.message : String(error);
        const detail = cause ?? code;
        return {
          kind: "transport-error",
          detail: detail === undefined ? message : `${message}: ${detail}`,
        };
      }
    },
  };
}

/**
 * The body, but only when something will read it.
 *
 * `recordPage` parses a body only for a 2xx HTML response — a redirect's body is a stub,
 * an error page's body is the site nav, and a PDF has no parser here. Buffering the rest
 * into a JS string builds a value with no reader; `dump()` drains the socket instead, so
 * keep-alive still works. The empty string that comes back is never mistaken for a page:
 * `recordPage` applies the same test before it parses anything.
 */
async function readBody(
  response: {
    statusCode: number;
    body: { text(): Promise<string>; dump(): Promise<void> };
  },
  headers: Readonly<Record<string, string>>,
): Promise<string> {
  const parsable =
    response.statusCode >= 200 &&
    response.statusCode < 300 &&
    isHtmlContentType(headers["content-type"]);
  if (parsable) return response.body.text();
  await response.body.dump();
  return "";
}

/**
 * undici gives a repeated header as an array and an absent one as undefined. Joining
 * with ", " matches what a single folded header line would have been, which is what
 * `headerNoindex` parses — an `X-Robots-Tag` sent twice must not become one of the two.
 */
function flatten(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    flat[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}
