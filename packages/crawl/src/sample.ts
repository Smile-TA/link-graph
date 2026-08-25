/**
 * The sample-ceiling policy, in one place (PRD §15).
 *
 * `agent.familyfirstlife.com` is 59,363 pages that are one page with a per-agent
 * substitution, so crawling it whole costs 16.5 hours at the measured 1 req/s and buys
 * nothing. Such a site is crawled to a ceiling instead, and the consequence is stated
 * rather than hidden: `analyse` reports `orphans: null` with the reason `sampled`.
 *
 * Both halves of the policy live here — the ceiling a crawl may start with, and the
 * point at which it stops — because they are one rule seen from two ends, and split
 * across two files they would be two rules that only happen to agree.
 */
import type { SiteRow } from "@link-graph/db";

/**
 * Whether a crawl that has written `pagesWritten` pages has reached this site's
 * ceiling. Always false for a site crawled in full.
 */
export function atSampleCeiling(site: SiteRow, pagesWritten: number): boolean {
  return site.crawlScope === "sample" && pagesWritten >= (site.sampleCeiling ?? 0);
}

/**
 * The check step 5.5 left undone, and it belongs to the crawler because the crawler is
 * the thing that reads the ceiling.
 *
 * A `sample` site whose ceiling is at least its inventory gets crawled whole and still
 * reports `orphans: null` with the reason `sampled` — suppressing a count it could have
 * produced. That is the mirror image of reporting a zero nobody measured, and the paired
 * CHECK in `008_sample_scope.sql` cannot see it: the ceiling and the inventory size are
 * not in the same row, or even in the same table.
 *
 * Not checked when the site has no inventory (`inventorySize` 0): there is then no number
 * to compare against, and refusing on that basis would be an invented rule.
 */
export function sampleCeilingProblem(
  site: SiteRow,
  inventorySize: number,
): string | null {
  if (
    site.crawlScope !== "sample" ||
    site.sampleCeiling === null ||
    inventorySize === 0
  ) {
    return null;
  }
  if (site.sampleCeiling < inventorySize) return null;
  return (
    `site ${site.siteId} is crawl_scope 'sample' with sample_ceiling ` +
    `${site.sampleCeiling}, which is not smaller than its ${inventorySize}-URL truth ` +
    `source. The crawl would cover the whole site and still report orphans as ` +
    `unknown for the reason 'sampled' — either lower the ceiling or set crawl_scope ` +
    `to 'full'`
  );
}
