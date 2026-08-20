/**
 * The inventory itself: permalinks turned into node identity, and the two sources kept
 * apart. Pure.
 *
 * **Why the two sources are merged rather than one winning.** PRD §4 resolves in order
 * and takes the first success, and PRD §13 requires REST totals cross-checked against
 * sitemap counts — a cross-check whose loser is then discarded produces a finding nobody
 * can act on. Measured on integrity.com's `page` post type: REST lists 124 published
 * pages and `page-sitemap.xml` lists 96 of them, so 28 published pages are in the CMS
 * and not in the sitemap (PRD §2's `sitemap-invisible`). Verified live: `/news/` returns
 * 200, is self-canonical and carries no robots `noindex` — an ordinary page the sitemap
 * omits. Taking REST alone would hide the disagreement; taking the sitemap alone would
 * hide 28 pages, and a page absent from the inventory can never be reported as an
 * orphan.
 *
 * So the union is the inventory, and each URL carries which source knew about it.
 */
import { normalizeUrl, type SiteHosts } from "@link-graph/core";

/** One URL as a single source found it, after normalization. */
export interface FoundUrl {
  /** Absolute, normalized: the identity `pages.url_normalized` will hold. */
  readonly url: string;
  readonly path: string;
  /** The WordPress post type, when the source knew it. A sitemap never does. */
  readonly postType: string | null;
}

/** One URL of the inventory, and which of the two sources listed it. */
export interface TruthUrl extends FoundUrl {
  readonly inRest: boolean;
  readonly inSitemap: boolean;
}

/**
 * The three numbers `crawls` stores. `null` means "that source was not available",
 * never zero: an absent source has no count, and every count derived from a zero it did
 * not measure is wrong (PRD §13).
 */
export interface TruthCounts {
  readonly total: number | null;
  readonly rest: number | null;
  readonly sitemap: number | null;
}

export interface Gathered {
  readonly urls: readonly FoundUrl[];
  /** URLs outside the site's alias set — another site's pages, not this one's. */
  readonly foreign: readonly string[];
  /** URLs `normalizeUrl` refuses: not a crawlable page at all. */
  readonly unusable: readonly string[];
  /** Entries naming a URL an earlier entry already named. */
  readonly duplicates: number;
}

/**
 * Normalize one source's permalinks into node identity, dropping nothing silently.
 *
 * A foreign URL is dropped rather than adopted: a sitemap that lists another host's
 * pages would otherwise put them in this site's inventory, where every one of them is
 * an orphan nothing links to. The count comes back so the caller can report it.
 */
export function gather(
  entries: readonly { url: string; postType: string | null }[],
  site: SiteHosts,
): Gathered {
  const urls: FoundUrl[] = [];
  const foreign: string[] = [];
  const unusable: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const entry of entries) {
    const normalized = normalizeUrl(entry.url, site);
    if (normalized === null) {
      unusable.push(entry.url);
      continue;
    }
    if (!normalized.isInternal) {
      foreign.push(entry.url);
      continue;
    }
    if (seen.has(normalized.href)) {
      duplicates += 1;
      continue;
    }
    seen.add(normalized.href);
    urls.push({
      url: normalized.href,
      path: normalized.path,
      postType: entry.postType,
    });
  }
  return { urls, foreign, unusable, duplicates };
}

/**
 * The union of what the two sources found. Either may be `null`, meaning that source
 * does not exist for this site.
 */
export function mergeInventories(
  rest: readonly FoundUrl[] | null,
  sitemap: readonly FoundUrl[] | null,
): { urls: readonly TruthUrl[]; counts: TruthCounts } {
  const merged = new Map<string, TruthUrl>();
  for (const found of rest ?? []) {
    merged.set(found.url, { ...found, inRest: true, inSitemap: false });
  }
  for (const found of sitemap ?? []) {
    const existing = merged.get(found.url);
    merged.set(found.url, {
      // The post type comes from REST when REST knew it: the sitemap carries none, and
      // overwriting a known post type with null would lose the only fact that lets a
      // later step classify page-builder artifacts (PRD §4).
      ...(existing ?? found),
      inRest: existing?.inRest ?? false,
      inSitemap: true,
    });
  }
  const urls = [...merged.values()];
  return {
    urls,
    counts: {
      total: rest === null && sitemap === null ? null : urls.length,
      rest: rest === null ? null : rest.length,
      sitemap: sitemap === null ? null : sitemap.length,
    },
  };
}

/**
 * PRD §2's `sitemap-invisible`: URLs the CMS publishes and the sitemap omits.
 *
 * It is `|union| - |sitemap|` — arithmetic, not a fourth stored number, which is why
 * `crawls` stores three counts and not four. It also means the answer is `null` rather
 * than `0` for any site where the two sources were not both read, which is the property
 * PRD §13 asks for: never report a zero you did not measure.
 */
export function sitemapInvisible(counts: TruthCounts): number | null {
  return absentFrom(counts, "sitemap");
}

/** The mirror: URLs the sitemap lists and the CMS does not report (PRD §4). */
export function restMissing(counts: TruthCounts): number | null {
  return absentFrom(counts, "rest");
}

/**
 * How many URLs of the union one source did not list — unknown unless BOTH sources were
 * read, since with one source the union is that source and the answer would be a
 * meaningless 0.
 */
function absentFrom(counts: TruthCounts, source: "rest" | "sitemap"): number | null {
  if (counts.total === null || counts.rest === null || counts.sitemap === null) {
    return null;
  }
  return counts.total - (counts[source] ?? 0);
}
