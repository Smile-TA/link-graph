/**
 * PRD §2's taxonomy as a pure function: one page's facts in, its class out.
 *
 * Why this is not SQL. The graph maths — inbound counts, depth — is SQL, because PRD §7
 * says so and because a `GROUP BY` and a recursive CTE are the right tools. The taxonomy
 * is not graph maths: it is a precedence order over seven booleans, it is where a wrong
 * answer is both silent and consequential (PRD §13: "an orphan report that is 30% noise
 * gets ignored within two weeks"), and engineering guide §3.1 names the orphan set
 * difference as one of the places TDD is mandatory. Keeping it here means every rule is
 * covered by the unit tier, with no database running.
 *
 * The vocabulary itself lives beside the column it constrains, in `@link-graph/db`, with
 * `TRUTH_SOURCES` and `CRAWL_STATUSES`.
 */
import type { PageClass, TruthSource } from "@link-graph/db";

export type { PageClass };

/**
 * Exactly the facts the taxonomy reads, and no others. It is deliberately not derived
 * from the `pages` row: that row also carries `class`, this function's own previous
 * output, and a taxonomy that could read its own last answer is a taxonomy that can
 * drift on a re-run.
 */
export interface PageFacts {
  readonly urlNormalized: string;
  /** Root-relative path including query — what `ignorePaths` is matched against. */
  readonly path: string;
  /** `null` = never fetched. Never read as 200. */
  readonly statusCode: number | null;
  readonly indexable: boolean;
  /** `null` = the page declared no usable canonical, which is not the same as self. */
  readonly canonicalTo: string | null;
  readonly redirectTo: string | null;
  readonly inTruthSource: boolean;
  /**
   * Whether this page is where the crawl's reachability is measured from — the site's
   * homepage. A named fact rather than `depth === 0`, so that a future crawl seeded from
   * a sitemap rather than the homepage cannot silently change what the rule below means.
   */
  readonly isCrawlRoot: boolean;
  /** Inbound internal edges from other pages of this crawl. Self-links excluded. */
  readonly inboundTotal: number;
  /** Of those, the ones that are not boilerplate. */
  readonly inboundContextual: number;
}

export interface SiteRules {
  /**
   * `null` = not resolved yet, `'none'` = resolved and there is none. Neither can answer
   * the orphan question (PRD §2, Undetectable).
   */
  readonly truthSource: TruthSource | null;
  readonly ignorePaths: readonly string[];
}

/**
 * Whether this site has an inventory to take the set difference against. Exported
 * because the metrics assembly needs exactly the same test — the rule has one home.
 */
export function hasTruthSource(site: SiteRules): boolean {
  return site.truthSource !== null && site.truthSource !== "none";
}

/**
 * Whether an `ignore_paths` entry covers this path.
 *
 * Read as a path prefix at a segment boundary: `/newsletters/` covers
 * `/newsletters/2026/` and the entry itself, and does not cover `/newsletters-archive/`.
 * The pattern language belongs to the curation overlay (PRD §3, step 9) and no site in
 * the estate has an entry yet, so this is the conservative reading — but the column is
 * read rather than ignored, because a curated exclusion that silently did nothing would
 * put the phantom orphans of PRD §2 straight back into the list.
 */
function isIgnored(path: string, ignorePaths: readonly string[]): boolean {
  return ignorePaths.some((entry) => {
    if (path === entry) return true;
    const prefix = entry.endsWith("/") ? entry : `${entry}/`;
    return path.startsWith(prefix);
  });
}

/**
 * PRD §2's Excluded: "not an orphan by intent". `noindex`, a canonical pointing
 * elsewhere, a redirect, an `ignorePaths` match — and a status that is not a success,
 * because PRD §2 requires an orphan to be *published*, and a sitemap URL that 404s is a
 * broken inventory entry rather than a page nobody links to. Reporting one as an orphan
 * is exactly the false positive PRD §13 says destroys trust.
 */
function isExcluded(page: PageFacts, site: SiteRules): boolean {
  return (
    !page.indexable ||
    (page.canonicalTo !== null && page.canonicalTo !== page.urlNormalized) ||
    page.redirectTo !== null ||
    (page.statusCode !== null && page.statusCode >= 300) ||
    isIgnored(page.path, site.ignorePaths)
  );
}

/**
 * Classify one page. The order of the rules is the specification, so it is written out
 * rather than folded into a lookup:
 *
 * 1. **Excluded** first, because it means "do not ask the orphan question here", and
 *    that has to outrank every answer to it.
 * 2. **The crawl root** is never an orphan. Measured on 403bplan.net: the homepage's
 *    only inbound edges are 13 header logo links with an empty anchor, so the
 *    `(target, anchor)` pair is on 100% of pages, every inbound edge is boilerplate, and
 *    the letter of PRD §2 makes the homepage a soft orphan. It is reachable in zero
 *    clicks by definition, and a report that opens by calling the homepage an orphan
 *    loses the reader on line one.
 * 3. **Undetectable** — no truth source, so no inventory to difference against, so the
 *    orphan question is unanswerable and must not be answered with a zero (PRD §2).
 * 4. **Not in the truth source** — the question does not apply: the page exists and the
 *    inventory does not list it. Distinct from Excluded, which is about intent.
 * 5. Then the set difference itself: contextual inbound → linked, boilerplate-only
 *    inbound → soft orphan, nothing at all → true orphan.
 */
export function classifyPage(page: PageFacts, site: SiteRules): PageClass {
  if (isExcluded(page, site)) return "excluded";
  if (page.isCrawlRoot) return "linked";
  if (!hasTruthSource(site)) return "undetectable";
  if (!page.inTruthSource) return "not_in_truth_source";
  if (page.inboundContextual > 0) return "linked";
  if (page.inboundTotal > 0) return "soft_orphan";
  return "orphan";
}
