/**
 * What a crawl is allowed to start from, checked before a single request is made.
 *
 * Every rule here is a refusal, and every refusal is one of engineering guide §1's
 * failures-that-read-as-results caught at the only moment it is cheap: before the crawl
 * has spent hours of request budget producing rows nobody can trust.
 */
import { normalizeUrl, type SiteHosts } from "@link-graph/core";
import { isInventory, type SiteRow } from "@link-graph/db";
import { sampleCeilingProblem } from "./sample.js";

/** One inventory URL and the CMS object the truth source named for it (step 5). */
export interface SeedUrl {
  readonly url: string;
  /**
   * A post type slug, a taxonomy slug, or `author`. `null` when no source named one —
   * a flat `sitemap.xml` names nothing — and never read as content or non-content.
   */
  readonly postType: string | null;
}

export interface CrawlSeeds {
  /**
   * The truth source's inventory (step 5's `resolveTruthSource().urls`). These are the
   * pages whose absence from the link graph makes an orphan, so `in_truth_source` is
   * true for exactly these and false for everything the crawl discovers.
   */
  readonly urls: readonly SeedUrl[];
  /**
   * How large the inventory was, for the `crawls` row. Three counts because the two
   * sources disagree in both directions and the disagreement is itself a finding
   * (006_truth_source.sql); `analyse`'s coverage gate divides by the first.
   */
  readonly truthSourceUrls: number | null;
  readonly truthSourceRestUrls: number | null;
  readonly truthSourceSitemapUrls: number | null;
  /**
   * The site's taxonomy vocabulary, as this resolution found it (`crawls.taxonomies`).
   * `analyse` reads it to turn a page's post type into PRD §4's Excluded decision, and
   * it travels with the seeds because it is a fact about the same resolution.
   */
  readonly taxonomies: readonly string[];
}

/**
 * What is wrong with these seeds, as a sentence, or `null` if nothing is.
 *
 * Only the union count is checked against the seed list here. The relationship between
 * the three counts — the union is at least the larger and at most the sum — is the CHECK
 * in `006_truth_source.sql`, and the `crawls` row is inserted before the first request,
 * so a violation still stops the crawl before it fetches anything. Restating that
 * arithmetic here would be a second copy of it to drift.
 */
export function seedProblem(site: SiteRow, seeds: CrawlSeeds): string | null {
  const hosts: SiteHosts = { canonicalHost: site.canonicalHost, aliases: site.aliases };
  const seen = new Set<string>();
  for (const [index, seed] of seeds.urls.entries()) {
    const problem = seedUrlProblem(seed.url, index, hosts, seen);
    if (problem !== null) return problem;
    seen.add(seed.url);
  }

  const inventory = isInventory(site.truthSource);
  if (inventory && seeds.urls.length === 0) {
    return (
      `site ${site.siteId} has truth_source '${String(site.truthSource)}' and no seed ` +
      `URLs. An inventory of nothing is a failed resolution, not an answer (PRD §4), ` +
      `and crawling from the homepage alone would report its whole page list as not ` +
      `in the truth source`
    );
  }
  if (!inventory && (seeds.urls.length > 0 || seeds.truthSourceUrls !== null)) {
    return (
      `site ${site.siteId} has truth_source ${site.truthSource ?? "null"}, which is ` +
      `not an inventory, but ${seeds.urls.length} seed URL(s) were given for it. A ` +
      `site with no inventory cannot have a size for one, and 006_truth_source.sql ` +
      `refuses the row`
    );
  }
  if (inventory && seeds.truthSourceUrls === null) {
    return (
      `site ${site.siteId} has an inventory of ${seeds.urls.length} URL(s) but no ` +
      `recorded size for it. Without truthSourceUrls, "0 orphans" and "the crawl ` +
      `fetched one page of two thousand" are the same row (006_truth_source.sql)`
    );
  }
  if (seeds.truthSourceUrls !== null && seeds.truthSourceUrls !== seeds.urls.length) {
    return (
      `truthSourceUrls is ${seeds.truthSourceUrls} but ${seeds.urls.length} seed ` +
      `URL(s) were given. The first is the denominator of the coverage gate and the ` +
      `second is what will actually be fetched; one of them is wrong`
    );
  }

  return sampleCeilingProblem(site, seeds.urls.length);
}

function seedUrlProblem(
  url: string,
  index: number,
  hosts: SiteHosts,
  seen: ReadonlySet<string>,
): string | null {
  const normalized = normalizeUrl(url, hosts);
  if (normalized === null) return `seed ${index} is not a crawlable URL: ${url}`;
  if (normalized.href !== url) {
    // `/contact-us` and `/contact-us/` are one page and two nodes. A crawl seeded with
    // a form the crawler would not store plants an orphan no correct graph maths
    // downstream can undo (PRD §13).
    return (
      `seed ${index} is not normalized: ${url} normalizes to ${normalized.href}. A ` +
      `crawl must be seeded with the identity it will store, or the page it fetches ` +
      `and the URL it was asked for are two nodes`
    );
  }
  if (!normalized.isInternal) {
    return `seed ${index} is not on this site: ${url} (aliases: ${hosts.aliases.join(", ")})`;
  }
  if (seen.has(url)) {
    return (
      `seed ${index} is a duplicate: ${url}. The inventory size is what coverage is ` +
      `measured against, so a list that counts one page twice overstates it`
    );
  }
  return null;
}
