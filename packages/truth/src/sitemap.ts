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

/**
 * WP core's own sitemap: `wp-sitemap-posts-page-1.xml`,
 * `wp-sitemap-taxonomies-category-1.xml`, `wp-sitemap-users-1.xml`.
 *
 * Only the first is measured on this estate — `agent.familyfirstlife.com` lists 30
 * `posts-page` children and nothing else — so the other two are core's documented
 * naming rather than a recording. They are here because without them a core-generated
 * taxonomy archive carries no name at all, and because neither pattern can match a name
 * any other generator produces.
 *
 * **Which of the two a name is, this deliberately does not say.** Gate 2: the flag
 * would have been true for no host in the estate — every one of the seven WordPress
 * hosts probed serves WP REST, whose `taxonomies` field names the same vocabulary — and
 * the machinery to carry it as far as `classifyPage` could not be exercised against any
 * recorded response. So `posts` and `taxonomies` are one pattern here: what is left is
 * name extraction, and every branch of that is tested.
 */
const CORE_OBJECT = /^\/wp-sitemap-(?:posts|taxonomies)-([^/]+)-\d+\.xml$/;
const CORE_USERS = /^\/wp-sitemap-users-\d+\.xml$/;

/**
 * Yoast: `<object>-sitemap.xml`, and `<object>-sitemap2.xml` onwards once an object has
 * more entries than one file holds. Measured on integrity.com (14 children) and
 * tidewatermg.com (34); the numbered form is Yoast's documented pagination and no
 * recorded index needs it, so the `\d*` is there to name a child rather than lose one.
 *
 * `[^/]+` and not `.+`, here and above: a greedy `.+` reads `/blog/page-sitemap.xml` as
 * an object called `blog/page` rather than declining to name it. Unreachable today —
 * every candidate is root-relative — and the cost of being wrong is a name that matches
 * nothing, which under-excludes rather than deleting a finding.
 */
const YOAST = /^\/([^/]+)-sitemap\d*\.xml$/;

/**
 * The CMS object a child sitemap lists — a post type slug, a taxonomy slug, or
 * `author` — or `null` when its URL does not say.
 *
 * This is the provenance PRD §4 needs and step 5 discarded: taxonomy archives are 17%
 * of tidewatermg.com's sitemap and 1% of integrity.com's, and nothing inside a child
 * sitemap distinguishes them from the site's content.
 */
export function sitemapChild(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  // The index candidates first, because `/wp-sitemap.xml` ends in `-sitemap.xml` and
  // the Yoast pattern would otherwise read it as an object called `wp`.
  if (SITEMAP_CANDIDATES.some((candidate) => candidate === path)) return null;
  // Normalized to Yoast's spelling rather than kept as `users`: PRD §2's class is
  // "author archives", and the same page carrying a different `post_type` depending on
  // which plugin generated the sitemap would be one fact with two names.
  if (CORE_USERS.test(path)) return "author";
  return CORE_OBJECT.exec(path)?.[1] ?? YOAST.exec(path)?.[1] ?? null;
}
