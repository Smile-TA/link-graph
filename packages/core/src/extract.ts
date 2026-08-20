/**
 * Link extraction: rendered HTML in, links and head signals out.
 *
 * `cheerio` is a string→DOM parser with no I/O, which is why this lives in `core`
 * alongside the pure functions — the one documented exception to engineering guide
 * §4.1 (implementation plan, step 2).
 *
 * **Parsing, not pattern matching.** Measured on the six captures (584 anchors, 539
 * links): a regex over the markup finds 24 `<a href>` a parser does not — 14 inside a
 * WS Form JavaScript string across the two tidewatermg.com captures, 10 commented out
 * across the two 403bplan.net ones. One of those comments is the only homepage link
 * to `/newsletter-signup/`, a page that is in the sitemap: a text-scraping extractor
 * would report it as linked and hide a real orphan.
 *
 * **Entity decoding stops here.** `normalizeUrl` requires text, not markup, and
 * WordPress writes `&#038;` for `&` inside href attributes. Measured: cheerio decodes
 * both attribute values and text nodes, so nothing else is needed — but the contract
 * is real, and `url.test.ts` pins what an undecoded entity does (the `&#038;` starts
 * a fragment, which is then stripped, silently truncating the query).
 */
import * as cheerio from "cheerio";
import { normalizeUrl, type NormalizedUrl, type SiteHosts } from "./url.js";

/**
 * The page region a link sits in — its `<a>`'s **outermost** HTML landmark ancestor.
 *
 * Why the outermost and not the nearest: every theme sampled from this estate writes
 * its menu as `<header><nav>` and its legal links as `<footer><nav>`, so the nearest
 * landmark labels both "nav" and the two become indistinguishable. The region is the
 * thing a boilerplate finding has to name ("this page is only linked from the
 * footer"), so the region is what we keep.
 *
 * Why a closed vocabulary and not a CSS path: step 4 has to pick the boilerplate
 * threshold N from data (PRD §15), which means aggregating across pages in SQL. Seven
 * values `GROUP BY` usefully; a per-theme selector path does not, and would churn on
 * every theme release, breaking the crawl diffs of step 13.
 */
export type LinkContainer =
  "header" | "footer" | "nav" | "aside" | "main" | "article" | "body";

/** Lowercase tag name → container, so the DOM walk needs no cast. */
const LANDMARKS: Readonly<Record<string, LinkContainer>> = {
  header: "header",
  footer: "footer",
  nav: "nav",
  aside: "aside",
  main: "main",
  article: "article",
};

export interface RawLink {
  /** Normalized target, so it can be compared with a page's identity directly. */
  readonly target: NormalizedUrl;
  /** Visible text, whitespace collapsed. Empty for an icon-only link. */
  readonly anchor: string;
  /** The `rel` attribute exactly as written, or `null` if absent. */
  readonly rel: string | null;
  readonly isNofollow: boolean;
  readonly container: LinkContainer;
  /**
   * Position in the page's `<a href>` sequence, counting the anchors we skip. Two
   * links from one page to one target (a logo in the header and again in the footer)
   * are separate edges, and without a position they would be indistinguishable rows
   * that someone downstream would dedupe, losing that fact.
   */
  readonly domIndex: number;
}

export interface HeadSignals {
  readonly title: string | null;
  /** `<base href>` resolved against the page URL, or `null` when there is none. */
  readonly baseHref: string | null;
  /**
   * Normalized `<link rel="canonical">`. `null` means the page declared no usable
   * canonical — never "the canonical points at this page", which is a different fact
   * and the one PRD §2's Excluded class turns on.
   */
  readonly canonical: NormalizedUrl | null;
  /** Every `meta robots` directive, lowercased, in document order. */
  readonly robots: readonly string[];
  readonly noindex: boolean;
}

export interface ExtractedPage {
  readonly links: readonly RawLink[];
  readonly head: HeadSignals;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Extract every crawlable link and the head signals from one page's rendered HTML.
 *
 * @param html     the response body, exactly as served
 * @param pageUrl  absolute URL this body was fetched from — the base for relative
 *                 hrefs unless the document overrides it with `<base href>`
 * @param site     the crawled site's canonical host and alias set
 */
export function extractPage(
  html: string,
  pageUrl: string,
  site: SiteHosts,
): ExtractedPage {
  // Engineering guide §1: an empty body is a fetch that failed, and returning zero
  // links for it would read downstream as a page nothing links out of.
  if (html.trim() === "") {
    throw new Error(`extractPage: empty HTML for ${pageUrl}`);
  }
  const parsed = parseAbsolute(pageUrl);
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    // Every relative href would resolve to null and the page would report no
    // internal links at all — a failure that looks exactly like a leaf page.
    throw new Error(
      `extractPage: pageUrl must be an absolute http(s) URL, got ${pageUrl}`,
    );
  }

  const $ = cheerio.load(html);

  // A `<base>` is only valid in the head, but browsers honour one found anywhere, and
  // so do we. An unparseable one is ignored the way a browser ignores it: relative
  // hrefs fall back to the page URL, and `baseHref` stays null because there is no
  // usable base to report.
  const declaredBase = $("base[href]").first().attr("href");
  const baseHref =
    declaredBase === undefined
      ? null
      : (parseAbsolute(declaredBase, pageUrl)?.toString() ?? null);
  const base = baseHref ?? pageUrl;

  const links: RawLink[] = [];
  $("a[href]").each((domIndex, el) => {
    const anchor = $(el);
    const target = normalizeUrl(anchor.attr("href") ?? "", site, base);
    if (target === null) return; // a scheme normalizeUrl rejects, or a bare fragment
    const rel = anchor.attr("rel") ?? null;
    // `.text()` concatenates every descendant text node, including the `<style>` block
    // Illustrator leaves inside an exported SVG icon. Measured: 2 of the 539 links in
    // the captures came out as ".cls-1{fill:#717171;}…VIP Portal". The boilerplate
    // rule keys on (target, anchor) (PRD §6), so that would make the key depend on
    // the theme's icon CSS.
    const visible = anchor.clone();
    visible.find("style, script").remove();
    links.push({
      target,
      anchor: collapse(visible.text()),
      rel,
      // `rel` is space-separated per the HTML spec. Commas are tolerated because some
      // plugins emit them; none of the six captures does.
      isNofollow: (rel ?? "")
        .toLowerCase()
        .split(/[\s,]+/)
        .includes("nofollow"),
      container: outermostLandmark(anchor.parents().toArray()),
      domIndex,
    });
  });

  // `title` is scoped to the head because an inline `<svg><title>` is a `title`
  // element too, and would win on any page whose head has none.
  const title = collapse($("head title").first().text());
  // `[href]` because a `<link rel=canonical>` with no href must not shadow the real
  // one: `null` here means "no usable canonical", which the Excluded class acts on.
  const canonicalHref = $('link[rel="canonical"][href]').first().attr("href");
  // Measured: css-select matches `rel` values ASCII case-insensitively (the HTML
  // spec's case-insensitive attribute list) but `name` values case-sensitively, so
  // `rel=Canonical` needs no flag and `name=ROBOTS` does. Every SEO plugin in this
  // estate writes lowercase; the flag costs nothing and reads one that does not.
  const robots = $('meta[name="robots" i]')
    .toArray()
    .flatMap((el) => ($(el).attr("content") ?? "").split(","))
    .map((directive) => directive.trim().toLowerCase())
    .filter((directive) => directive !== "");

  return {
    links,
    head: {
      title: title === "" ? null : title,
      baseHref,
      canonical:
        canonicalHref === undefined ? null : normalizeUrl(canonicalHref, site, base),
      robots,
      // Directives are comma-separated, but a hand-edited `content="noindex nofollow"`
      // is read by Google and would otherwise arrive here as one directive. A missed
      // noindex becomes a phantom orphan (PRD §2), so the test is on tokens rather
      // than whole directives. `none` is Google's shorthand for `noindex, nofollow`.
      noindex: robots
        .flatMap((directive) => directive.split(/\s+/))
        .some((token) => token === "noindex" || token === "none"),
    },
  };
}

function parseAbsolute(url: string, base?: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

/** `ancestors` is nearest-first, so the last landmark seen is the outermost one. */
function outermostLandmark(ancestors: { readonly tagName: string }[]): LinkContainer {
  let container: LinkContainer = "body";
  for (const ancestor of ancestors) {
    const landmark = LANDMARKS[ancestor.tagName];
    if (landmark !== undefined) container = landmark;
  }
  return container;
}
