/**
 * URL normalization. Node identity for the whole link graph depends on this, so it
 * lives in `core/` as a pure function and is driven by tests (engineering guide §3.1).
 *
 * Host aliases are NOT guessed: `deployment-configurations` declares them at
 * `ingress.entries[].hosts[].hostname`, where 145 of 312 prod hostnames are `www.`
 * variants. Without that table every `www.` link becomes a phantom external node and
 * every apex page looks orphaned.
 *
 * Two things this deliberately does NOT do:
 *
 * - **Resolve redirects.** `?p=123` and `/index.php/about/` name real resources whose
 *   pretty permalink cannot be known without a fetch. Redirect following (PRD §5)
 *   collapses them; guessing here would invent edges.
 * - **Decode HTML entities.** WordPress emits `&#038;` for `&` inside `href`
 *   attributes — 6 of 371 hrefs captured from the estate. That is the HTML parser's
 *   job (step 2); by the time an href reaches this function it must already be text.
 */

/** Query parameters that identify a campaign, not a resource. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^_ga$/i,
];

/**
 * Parameters WordPress bolts onto its own links and that never change the page.
 * `?p=` and `?page_id=` are absent on purpose — those ARE the identity.
 */
const WP_NOISE_PARAMS = [/^replytocom$/i, /^unapproved$/i, /^moderation-hash$/i];

/** Schemes that never represent a crawlable page. */
const NON_NAVIGABLE = new Set(["mailto:", "tel:", "javascript:", "data:", "sms:"]);

/** A final path segment that looks like a filename rather than a page. */
const LOOKS_LIKE_FILE = /\.[A-Za-z0-9]{1,8}$/;

/**
 * WordPress infrastructure, not permalink space. Measured 2026-08-19: the REST routes
 * `/wp-json/oembed/1.0/embed` and `/wp-json/wp/v2/types` return 200 both with and
 * without a trailing slash and issue no redirect — so unlike a permalink, there is no
 * canonical form to converge on, and rewriting one would be an unjustified guess.
 */
const WP_INFRA_PATH = /^\/wp-(json|admin|includes|content)\//i;

/** RFC 3986 §2.3 unreserved set — these must never stay percent-encoded. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

export interface SiteHosts {
  /** The host every alias collapses to. */
  readonly canonicalHost: string;
  /** Every host serving this site, including `canonicalHost`. */
  readonly aliases: readonly string[];
}

/** The fields `siteHosts` needs — a structural subset of `@link-graph/db`'s `SiteRow`. */
export interface SiteHostConfig {
  readonly canonicalHost: string;
  readonly aliases: readonly string[];
  readonly stageHost: string | null;
}

/**
 * Which host identity a crawl treats as canonical (PRD §8, step 14): the site's own
 * prod host and aliases, or — for a staging crawl — the stage host alone. A staging
 * domain has no aliases of its own; using the prod alias set against it would collapse
 * unrelated hosts into the same node.
 *
 * One function rather than each caller building `SiteHosts` by hand: `crawl` and
 * `analyse` both derive node identity from a site row, and identity computed two ways
 * for the same crawl is exactly how a staging page's depth root would stop matching its
 * own rows (see `analyse`'s own note on its `homepageUrl` copy).
 */
export function siteHosts(site: SiteHostConfig, useStage: boolean): SiteHosts {
  if (!useStage) return { canonicalHost: site.canonicalHost, aliases: site.aliases };
  if (site.stageHost === null) {
    throw new Error(
      `site ${JSON.stringify(site.canonicalHost)} has no stage host configured`,
    );
  }
  // `aliases` must include the host itself — "every host serving this site, including
  // `canonicalHost`" is `SiteHosts`'s own contract, and a staging domain otherwise has
  // no www-variant or other alias of its own.
  return { canonicalHost: site.stageHost, aliases: [site.stageHost] };
}

export interface NormalizedUrl {
  /** Absolute URL with the canonical host, for use as node identity. */
  readonly href: string;
  /** Host after alias resolution. */
  readonly host: string;
  /** Root-relative path including query, matching the pw-template convention. */
  readonly path: string;
  readonly isInternal: boolean;
}

/**
 * Percent-escapes are case-insensitive, so `%2f` and `%2F` are the same byte and must
 * not become two nodes. Escaped unreserved characters are decoded outright: `/%7Euser/`
 * and `/~user/` are the same resource per RFC 3986 §6.2.2.2.
 */
function normalizePercentEncoding(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

/**
 * WordPress's canonical form for an extensionless path carries a trailing slash.
 * Measured 2026-08-19: `/about`, `/careers` and `/contact` all 301 to the slashed
 * form on three separate estate sites.
 *
 * Applied to internal permalinks only. We do not know how an external host routes,
 * and `connect.integrity.com/ClientsSSO` — a real link from integrity.com's homepage
 * — is exactly the case where inventing a slash would fabricate a broken link.
 * `WP_INFRA_PATH` space is excluded for the same reason.
 */
function applyWordPressPathRules(pathname: string): string {
  // `/index.php` and `/index.php/about/` are WP's non-pretty permalink forms.
  let path = pathname.replace(/\/index\.php(?=\/|$)/i, "");
  if (path === "") path = "/";
  if (path.endsWith("/") || WP_INFRA_PATH.test(path)) return path;

  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  return LOOKS_LIKE_FILE.test(lastSegment) ? path : `${path}/`;
}

/**
 * Normalize a single href. Returns `null` for anything that is not a crawlable page
 * (non-navigable schemes, bare fragments, unparseable input) — callers skip those
 * rather than recording a broken edge.
 *
 * @param href  raw href as found in the HTML, with entities already decoded
 * @param site  the crawled site's canonical host and alias set
 * @param base  absolute URL of the page the href was found on, for relative resolution
 */
export function normalizeUrl(
  href: string,
  site: SiteHosts,
  base?: string,
): NormalizedUrl | null {
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#")) return null;

  let url: URL;
  try {
    url = new URL(raw, base ?? `https://${site.canonicalHost}/`);
  } catch {
    return null;
  }

  if (NON_NAVIGABLE.has(url.protocol)) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "") return null;

  url.hostname = url.hostname.toLowerCase();
  url.hash = "";

  const aliases = new Set(site.aliases.map((a) => a.toLowerCase()));
  const isInternal = aliases.has(url.hostname);

  // http -> https for internal URLs only. Our estate is https-only behind CloudFront,
  // so treating the two schemes as separate nodes would double every page. We know
  // nothing about an external host's TLS support, and a broken-link report has to show
  // the URL that was actually linked — so external schemes are left as found.
  //
  // Default ports are already dropped by the URL parser; a non-default port is left
  // alone, since it denotes a different service rather than a duplicate of this one.
  if (isInternal) {
    url.protocol = "https:";
    url.hostname = site.canonicalHost.toLowerCase();
  }

  for (const key of [...url.searchParams.keys()]) {
    const isNoise =
      TRACKING_PARAMS.some((p) => p.test(key)) ||
      WP_NOISE_PARAMS.some((p) => p.test(key));
    if (isNoise) url.searchParams.delete(key);
  }

  // Sorting makes `?a=1&b=2` and `?b=2&a=1` one node, but it re-serializes the query:
  // it rewrites `?rsd` to `?rsd=` and re-escapes `:` and `,`. With fewer than two
  // parameters there is nothing to order, so leave the query exactly as found.
  if ([...url.searchParams.keys()].length >= 2) url.searchParams.sort();

  // `/?` and `/` are the same resource, but the URL parser keeps the dangling `?` in
  // `href`. The link checker rewrites it away before requesting, so a result for the
  // `?` form is rejected as being about a different URL (measured 2026-10-27: 35 rows
  // on planenroll.com, unverified since 2026-09-25). Assigning an empty search drops it.
  if (url.search === "") url.search = "";

  url.pathname = normalizePercentEncoding(url.pathname);
  if (isInternal) url.pathname = applyWordPressPathRules(url.pathname);

  return {
    href: url.toString(),
    host: url.hostname,
    path: `${url.pathname}${url.search}`,
    isInternal,
  };
}
