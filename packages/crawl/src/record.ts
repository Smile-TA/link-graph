/**
 * One fetched response → the rows a crawl stores for it. Pure: no I/O, no clock, so
 * every rule below is covered by the unit tier (engineering guide §4.1).
 *
 * This is where the crawler's half of node identity lives. `parseCrawlFixture` in
 * `@link-graph/db` derives `path` and `is_external` from the URL and refuses anything
 * else; step 3 recorded that the crawler must apply the identical rules or the two
 * inputs to `pages`/`links` name different nodes. They are identical because both come
 * from `normalizeUrl` — nothing here re-derives a path by string surgery.
 *
 * **A body is parsed only when the server said it served a page.** Three refusals and
 * one silence, each of them engineering guide §1:
 *
 * - a redirect has no page content, and its body is a stub;
 * - a non-2xx body is an error page carrying the whole site nav, so parsing it would
 *   credit a missing page with the menu as outbound edges and every nav target with an
 *   inbound edge from a page that does not exist;
 * - a non-HTML body has no parser here, and whatever cheerio found in a PDF would be
 *   edges nobody wrote;
 * - an empty HTML body, or one the server compressed after we asked for `identity`,
 *   yields zero links — a page that looks like a leaf. Both throw.
 */
import { extractPage, normalizeUrl } from "@link-graph/core";
import type { ExtractedPage, NormalizedUrl, RawLink, SiteHosts } from "@link-graph/core";
import type { LinkInput, PageInput } from "@link-graph/db";
import { isCrawlableTarget } from "./target.js";

/** A link with its endpoints not yet resolved to row ids — the insert does that. */
export type PageLink = Omit<LinkInput, "fromPageId" | "toPageId">;

export interface RecordInput {
  /** Node identity, as the frontier holds it. */
  readonly url: NormalizedUrl;
  readonly inTruthSource: boolean;
  /**
   * The CMS object the frontier carried for this URL — a post type slug, a taxonomy
   * slug or `author` (step 5's provenance). `null` for a discovered URL, and for one
   * from a source that named nothing.
   */
  readonly postType: string | null;
  readonly site: SiteHosts;
  readonly status: number;
  /** Response headers, names lowercased and repeats already joined. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Where a redirect pointed, normalized, or `null` when this was not a redirect. */
  readonly redirectTo: string | null;
}

export interface PageRecord {
  readonly page: PageInput;
  readonly links: readonly PageLink[];
  /** Internal targets this page introduces that the frontier should hold. */
  readonly discovered: readonly string[];
}

/** Types that carry markup `extractPage` can read. */
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

export function isHtmlContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const essence = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return HTML_TYPES.has(essence);
}

/**
 * Whether `X-Robots-Tag` says this page is not to be indexed.
 *
 * Measured 2026-08-20 (PRD §5.1): `403bplan.net/wp-json/` answers 200 with
 * `x-robots-tag: noindex`. It is a response header, so `extractPage` cannot see it and
 * step 2 deferred it here; `pages.indexable` is the meta tag and this header together.
 *
 * A directive may be scoped to one crawler (`googlebot: noindex`), and that still
 * counts: PRD §2's Excluded class is about intent, and a page the site does not want
 * indexed is not a page anyone wanted linked. `none` is Google's documented shorthand
 * for `noindex, nofollow`.
 *
 * **Split on whitespace as well as commas**, matching `extractPage`'s rule for the meta
 * tag exactly. The comma is what the header syntax says, but core accepts
 * `content="noindex nofollow"` because Google does — and a header form this rejected
 * while the identical meta tag was honoured would make `indexable` depend on which of
 * the two the site happened to use, on the field that decides orphan eligibility.
 */
export function headerNoindex(value: string | undefined): boolean {
  if (value === undefined) return false;
  return (
    value
      .split(",")
      // A per-crawler directive is `<user-agent>: <directives>`; the name is dropped
      // rather than matched, since the intent is the same whoever it is aimed at.
      .flatMap((part) => (part.split(":").at(-1) ?? "").trim().toLowerCase().split(/\s+/))
      .some((directive) => directive === "noindex" || directive === "none")
  );
}

export function recordPage(input: RecordInput): PageRecord {
  const { url, site, status, headers, redirectTo } = input;
  const parsed = parseBody(input);

  return {
    page: {
      urlNormalized: url.href,
      path: url.path,
      // The truth source's provenance, carried on the frontier because the seed list is
      // gone by the time the page is fetched. PRD §2's Excluded class reads it: without
      // it every taxonomy archive is a phantom orphan (~10% of tidewatermg.com's
      // sitemap, and 9 of integrity.com's 538 reported orphans).
      postType: input.postType,
      statusCode: status,
      // analyse computes depth and class; a value here would make an un-analysed crawl
      // look analysed (002_crawls.sql).
      depth: null,
      inTruthSource: input.inTruthSource,
      indexable:
        !headerNoindex(headers["x-robots-tag"]) && !(parsed?.head.noindex ?? false),
      canonicalTo: parsed?.head.canonical?.href ?? null,
      redirectTo,
      class: null,
    },
    links: parsed?.links.map(toLink) ?? [],
    discovered: discoveredFrom(url, site, redirectTo, parsed?.links ?? []),
  };
}

function parseBody(input: RecordInput): ExtractedPage | null {
  const { status, headers, body, redirectTo } = input;
  if (redirectTo !== null || status < 200 || status >= 300) return null;
  if (!isHtmlContentType(headers["content-type"])) return null;

  // We ask for `accept-encoding: identity` and 403bplan.net honours it (measured
  // 2026-08-24). A server that compressed anyway would hand cheerio bytes, which parse
  // to zero links and a page that reads as a leaf.
  const encoding = headers["content-encoding"];
  if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
    throw new Error(
      `recordPage: ${input.url.href} was served with content-encoding ${encoding}, ` +
        `which this crawler did not ask for and cannot decode. Parsing it would find ` +
        `no links and report the page as a leaf.`,
    );
  }
  // extractPage refuses an empty body itself, with the same reasoning; this call site
  // is where the URL is in scope.
  return extractPage(body, input.url.href, input.site);
}

function toLink(link: RawLink): PageLink {
  return {
    toUrlNormalized: link.target.href,
    anchor: link.anchor,
    rel: link.rel,
    isExternal: !link.target.isInternal,
    // NULL until analyse marks it. `false` would make every edge of an un-analysed
    // crawl look contextual (002_crawls.sql).
    isBoilerplate: null,
    container: link.container,
    domIndex: link.domIndex,
  };
}

/**
 * The internal targets this page hands to the frontier: its crawlable links, plus its
 * redirect target when it had one. Deduplicated, in first-seen order, and never the
 * page itself — it already has a row.
 */
function discoveredFrom(
  url: NormalizedUrl,
  site: SiteHosts,
  redirectTo: string | null,
  links: readonly RawLink[],
): string[] {
  const targets = links.map((l) => l.target);
  if (redirectTo !== null) {
    // Already normalized by fetch-page; re-parsed here to reach `isInternal` and
    // `path` rather than restating either rule.
    const target = normalizeUrl(redirectTo, site);
    if (target !== null) targets.unshift(target);
  }
  const seen = new Set<string>([url.href]);
  const discovered: string[] = [];
  for (const target of targets) {
    if (!target.isInternal || seen.has(target.href) || !isCrawlableTarget(target.path)) {
      continue;
    }
    seen.add(target.href);
    discovered.push(target.href);
  }
  return discovered;
}
