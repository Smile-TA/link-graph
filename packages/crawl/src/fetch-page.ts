/**
 * One page fetch, with the redirect decision PRD §5.1 records.
 *
 * **The alias hop.** Measured 2026-08-20: an apex/`www` mismatch in the registry makes
 * every page 301 from the host we ask for to the host the server serves.
 * `normalizeUrl` collapses aliases, so that redirect names the *same* node — recording
 * it would store every page of such a site as a 301 to itself and never read a body.
 * So it is followed inside this one fetch, at a cost of one extra request per page, and
 * counted (`aliasHops`) rather than hidden: on a site whose canonical host is wrong, a
 * 16.5-hour crawl becomes 33 hours and the count is how anyone would know.
 *
 * A redirect that names a *different* node is not followed: it is recorded on
 * `pages.redirect_to` and its target is queued as a page in its own right. Redirects
 * are deliberately never `links` rows (PRD §2) — a synthetic edge would enter the
 * boilerplate `(target, anchor)` frequency count.
 */
import { normalizeUrl } from "@link-graph/core";
import type { NormalizedUrl, SiteHosts } from "@link-graph/core";
import type { FetchResponse, FetchResult } from "./fetcher.js";
import { isThrottled, retryAfterSeconds } from "./throttle.js";

export interface FetchedPage {
  readonly kind: "page";
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Normalized redirect target, or `null` when the response was not a redirect. */
  readonly redirectTo: string | null;
  /** Redirects followed inside this fetch because they named the same node. */
  readonly aliasHops: number;
}

export interface ThrottledFetch {
  readonly kind: "throttled";
  readonly status: number;
  /** From `retry-after`. Measured on Wordfence: 3600. `null` when absent. */
  readonly retryAfterSeconds: number | null;
  readonly detail: string;
}

export interface FailedFetch {
  readonly kind: "error";
  readonly detail: string;
}

export type FetchOutcome = FetchedPage | ThrottledFetch | FailedFetch;

export interface FetchPageInput {
  readonly url: NormalizedUrl;
  readonly site: SiteHosts;
  /** Already rate-limited by the caller, so an alias hop is paced like any request. */
  readonly get: (url: string) => Promise<FetchResult>;
  readonly now: () => Date;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * How many same-node redirects to follow before calling it a loop. One is the measured
 * case (apex → www); the allowance covers a host that also redirects a second axis
 * (`http` → `https`, or a trailing slash) before serving, and stops well short of the
 * infinite ping-pong two misconfigured aliases produce.
 */
const MAX_ALIAS_HOPS = 3;

export async function fetchPage(input: FetchPageInput): Promise<FetchOutcome> {
  const { url, site, get, now } = input;
  // The URL actually requested drifts from the node identity across alias hops, and it
  // is the base a relative Location resolves against.
  let requestUrl = url.href;

  for (let aliasHops = 0; aliasHops <= MAX_ALIAS_HOPS; aliasHops++) {
    const result = await get(requestUrl);
    if (result.kind === "transport-error") {
      return { kind: "error", detail: result.detail };
    }
    if (isThrottled(result.status)) {
      const seconds = retryAfterSeconds(result.headers["retry-after"], now());
      return {
        kind: "throttled",
        status: result.status,
        retryAfterSeconds: seconds,
        detail:
          `${requestUrl} answered ${result.status}` +
          (seconds === null ? " with no retry-after" : `, retry-after ${seconds}s`),
      };
    }

    const redirect = redirectTarget(result, site, requestUrl);
    // A redirect to somewhere else, or one with no usable Location: both are recorded
    // on the page rather than followed. A 3xx with nothing to follow is still a 3xx,
    // and PRD §2 excludes it either way — the row shows the status and an empty target
    // rather than a guess.
    if (
      redirect === null ||
      redirect.target === null ||
      redirect.target.href !== url.href
    ) {
      return {
        kind: "page",
        status: result.status,
        headers: result.headers,
        body: result.body,
        redirectTo: redirect?.target?.href ?? null,
        aliasHops,
      };
    }

    // Same node, different host or spelling: follow the Location as served, keeping the
    // identity we came in with. Following the *normalized* form would ask for the
    // canonical host again and loop.
    requestUrl = redirect.absolute;
  }

  return {
    kind: "error",
    detail:
      `${url.href} redirected to itself more than ${MAX_ALIAS_HOPS} times. Its ` +
      `aliases resolve to one node, so following further would not terminate; check ` +
      `the site's canonical_host against what the server serves.`,
  };
}

/**
 * Where a redirect points: the Location as served (resolved to absolute) and its node
 * identity. `null` when the response was not a redirect or carried no Location;
 * `target: null` when the Location is not a crawlable URL at all.
 *
 * Both forms are needed. The absolute one is what a following hop must request — the
 * normalized one is the canonical host, which is what we were redirected *away* from.
 */
function redirectTarget(
  response: FetchResponse,
  site: SiteHosts,
  requestUrl: string,
): { absolute: string; target: NormalizedUrl | null } | null {
  if (!REDIRECT_STATUSES.has(response.status)) return null;
  const location = response.headers["location"];
  if (location === undefined || location.trim() === "") return null;
  let absolute: URL;
  try {
    // Resolved against the URL actually requested, not the node identity: RFC 9110
    // permits a relative Location, and the wrong base would invent a node under the
    // wrong path.
    absolute = new URL(location, requestUrl);
  } catch {
    return null;
  }
  return {
    absolute: absolute.toString(),
    target: normalizeUrl(absolute.toString(), site),
  };
}
