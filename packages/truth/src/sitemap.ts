/**
 * Sitemap XML, parsed. Pure: no I/O, so every rule below is unit-tested against
 * recorded production sitemaps (engineering guide §4.1).
 *
 * **A parser, not a regex**, for the reason step 2 recorded: a `<url>` inside an XML
 * comment is not a URL, and a `<loc>` scan finds it. cheerio is a string→DOM parser
 * with no I/O, which is why it is allowed here at all.
 *
 * **`sitemapper` was not used**, though PRD §5.0 names it. It does its own fetching, so
 * a unit test of the parsing would have to reach the network — the one thing engineering
 * guide §4.2 says never happens. Its remaining job is the twelve lines below.
 */
import * as cheerio from "cheerio";
import type { HttpResponse } from "./http.js";

/** PRD §4's order. `sitemap.xml` often redirects to one of the other two. */
export const SITEMAP_CANDIDATES = [
  "/sitemap_index.xml",
  "/sitemap.xml",
  "/wp-sitemap.xml",
] as const;

export interface SitemapDoc {
  /** `index` children are sitemaps; `urlset` locs are pages. */
  readonly kind: "index" | "urlset";
  readonly locs: readonly string[];
}

/**
 * Parse one sitemap document, or `null` if it is not one. The root element decides:
 * a 404 HTML page also contains no `<loc>`, but saying "not a sitemap" about it is the
 * fact the caller needs.
 */
export function parseSitemap(xml: string): SitemapDoc | null {
  // An empty body is not XML, and cheerio would return an empty document for it.
  // Tested rather than trimmed: a sitemap child can be 235 KB, and this is asked of
  // every one of the 30 that agent.familyfirstlife.com has.
  if (!/\S/.test(xml)) return null;
  const $ = cheerio.load(xml, { xml: true });
  const root = $.root().children().first();
  const name = root.get(0)?.tagName;
  const kind = name === "sitemapindex" ? "index" : name === "urlset" ? "urlset" : null;
  if (kind === null) return null;
  const selector =
    kind === "index" ? "sitemapindex > sitemap > loc" : "urlset > url > loc";
  const locs = $(selector)
    .map((_, element) => $(element).text().trim())
    .get()
    .filter((loc) => loc !== "");
  // A sitemap with no entries is an empty result, and an empty result is never an
  // answer (engineering guide §1) — the caller must go on to the next candidate.
  return locs.length === 0 ? null : { kind, locs };
}

export type SitemapResponse =
  | {
      readonly kind: "sitemap";
      readonly doc: SitemapDoc;
      readonly degraded: string | null;
    }
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "not-a-sitemap"; readonly detail: string };

/**
 * What one response to a sitemap URL means. **Content decides, and the status is
 * recorded** — measured 2026-08-20, and this is the sharpest engineering guide §1 case
 * found in the estate so far: `agent.familyfirstlife.com/wp-sitemap-posts-page-30.xml`
 * answers **HTTP 404 with a valid 161 KB `<urlset>` of 1,362 URLs**, every one of which
 * WP REST independently confirms exists. Trusting the status code drops 1,362 real
 * pages out of the inventory, where they can never be reported as orphans; ignoring it
 * hides an anomaly worth a bug report. So the body is used and the status travels with
 * it as a finding.
 */
export function readSitemapResponse(
  response: Pick<HttpResponse, "status" | "headers" | "body">,
): SitemapResponse {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers["location"];
    if (location === undefined) {
      return {
        kind: "not-a-sitemap",
        detail: `HTTP ${response.status} with no location`,
      };
    }
    return { kind: "redirect", location };
  }
  const doc = parseSitemap(response.body);
  if (doc === null) {
    return { kind: "not-a-sitemap", detail: `HTTP ${response.status}, no sitemap XML` };
  }
  const ok = response.status >= 200 && response.status < 300;
  return { kind: "sitemap", doc, degraded: ok ? null : `HTTP ${response.status}` };
}
