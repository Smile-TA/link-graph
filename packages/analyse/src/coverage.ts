/**
 * How much of the truth source a crawl actually covers — a pure rule, for the reason
 * `classify.ts` gives for the taxonomy: engineering guide §4.1's test is that a rule
 * which is hard to test is in the wrong layer, and this is the highest-consequence
 * number in step 5. The service fetches the two counts; the verdict is decided here and
 * is covered by the unit tier with no database running.
 *
 * **Why it exists at all.** Orphan detection is a set difference against an inventory,
 * so a URL the crawl has no page row for cannot appear in the difference. A crawl
 * covering a fraction of the inventory therefore under-reports orphans and reports the
 * shortfall as `orphans: 0` — engineering guide §1's failure that reads as good news.
 * Measured: the four step-3 captures do exactly that, one of them one page of 1,953.
 */

/**
 * The share of the truth source a crawl must have page rows for. **No measurement pins
 * this number, which is why `analyse` takes it as an option.** The only complete crawl
 * that exists covers 13 of 13 (100%) and the failure being caught is 1 of 1,953
 * (0.05%); there is no data in between. 90 is chosen for the shape of a legitimate
 * shortfall — per-URL accidents: an inventory URL unpublished between resolution and
 * crawl, a redirect stored under its target — and one such accident on the smallest
 * sitemapped estate sites is already 7.7% of a 13-URL inventory, so a stricter default
 * would refuse healthy crawls of small sites while anything below 90% is systematic.
 * Recalibrate at step 7, when a real full crawl gives the distribution.
 */
export const DEFAULT_MIN_TRUTH_SOURCE_COVERAGE_PCT = 90;

/**
 * What is wrong with this crawl's coverage, as a sentence, or `null` if nothing is.
 *
 * `covered` counts the inventory URLs the crawl has a fetched page row for.
 * `inventory === null` — a site that has a truth source and a crawl that never recorded
 * how large it was — is a problem rather than a pass: what fraction of the site the
 * numbers describe is then unknowable, and unknown must not come out as a number.
 */
/**
 * A percentage a reader can act on. `toFixed(1)` rounds the flagship case — 1 page of
 * integrity.com's 1,953 — up to "0.1%", which is double the truth and reads as if the
 * crawl got somewhere; two significant figures keeps it 0.051%.
 */
function percent(pct: number): string {
  return pct >= 10 ? pct.toFixed(1) : pct.toPrecision(2);
}

export function truthSourceCoverageProblem(
  covered: number,
  inventory: number | null,
  minPct: number,
): string | null {
  if (inventory === null) {
    return (
      `it is of a site with a truth source but records no truth_source_urls, so what ` +
      `fraction of the site it covers is unknown. Resolve the truth source ` +
      `(packages/truth) and record its size on the crawl: without it "0 orphans" and ` +
      `"the crawl fetched one page of two thousand" are the same row`
    );
  }
  if (inventory <= 0) {
    // Unreachable through `analyse` today — `006_truth_source.sql` refuses a
    // non-positive size — and checked anyway, because `(0/0)*100` is NaN and
    // `NaN < minPct` is false, so the one input this module exists to reject would
    // otherwise come back as "no problem".
    return (
      `it records a truth source of ${inventory} URL(s), which is not an inventory: ` +
      `an empty truth source is a failed resolution, never an answer`
    );
  }
  if (covered > inventory) {
    return (
      `it has ${covered} page(s) marked in_truth_source but its truth source held ` +
      `${inventory}. One of the two is wrong, and the orphan set difference is against ` +
      `the smaller of them`
    );
  }
  const pct = (covered / inventory) * 100;
  if (pct < minPct) {
    return (
      `it has page rows for ${covered} of the ${inventory} URL(s) in its truth source ` +
      `(${percent(pct)}%, below the required ${minPct}%). The ${inventory - covered} ` +
      `URL(s) it never saw cannot be reported as orphans, so every count from this ` +
      `crawl understates the site`
    );
  }
  return null;
}
