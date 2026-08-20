/**
 * URL normalization. Node identity for the whole link graph depends on this, so it
 * lives in `core/` as a pure function and is driven by tests (engineering guide §3.1).
 *
 * Host aliases are NOT guessed: `deployment-configurations` declares them at
 * `ingress.entries[].hosts[].hostname`, where 145 of 312 prod hostnames are `www.`
 * variants. Without that table every `www.` link becomes a phantom external node and
 * every apex page looks orphaned.
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

/** Schemes that never represent a crawlable page. */
const NON_NAVIGABLE = new Set(["mailto:", "tel:", "javascript:", "data:", "sms:"]);

export interface SiteHosts {
  /** The host every alias collapses to. */
  readonly canonicalHost: string;
  /** Every host serving this site, including `canonicalHost`. */
  readonly aliases: readonly string[];
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
 * Normalize a single href. Returns `null` for anything that is not a crawlable page
 * (non-navigable schemes, bare fragments, unparseable input) — callers skip those
 * rather than recording a broken edge.
 *
 * @param href  raw href as found in the HTML
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

  // http -> https: the estate is https-only behind CloudFront, and treating the two
  // as separate nodes would double every page.
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  url.port = "";

  const aliases = new Set(site.aliases.map((a) => a.toLowerCase()));
  const isInternal = aliases.has(url.hostname);
  if (isInternal) url.hostname = site.canonicalHost.toLowerCase();

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((p) => p.test(key))) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  return {
    href: url.toString(),
    host: url.hostname,
    path: `${url.pathname}${url.search}`,
    isInternal,
  };
}
