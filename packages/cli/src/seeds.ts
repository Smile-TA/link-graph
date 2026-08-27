/**
 * Step 5's answer as step 6's seeds — the one place the two packages meet, and the only
 * translation this command performs.
 *
 * It is deliberately dumb. Everything that could be wrong about these seeds is already
 * refused by `seedProblem` in `packages/crawl` before a request is made — a URL that is
 * not normalized, an inventory whose size disagrees with its own list, seeds for a site
 * with no truth source — and restating those rules here would be a second copy of them
 * to drift.
 *
 * The one thing that only this function can get wrong is the pairing of the two
 * per-source counts, which is invisible on a site where the sources agree.
 */
import type { CrawlSeeds } from "@link-graph/crawl";
import type { TruthSourceResult } from "@link-graph/truth";

export function crawlSeeds(truth: TruthSourceResult): CrawlSeeds {
  return {
    urls: truth.urls.map((url) => ({ url: url.url, postType: url.postType })),
    // `null`, never 0, for a site with no inventory: `006_truth_source.sql` refuses a
    // size of zero, and a zero here would be a denominator nobody measured.
    truthSourceUrls: truth.counts.total,
    truthSourceRestUrls: truth.counts.rest,
    truthSourceSitemapUrls: truth.counts.sitemap,
    // The other half of PRD §4's Excluded rule: the post type above says which CMS
    // object a URL is, and this says which of those names are taxonomies on this site.
    taxonomies: truth.taxonomies,
  };
}
