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
import { isInventory } from "@link-graph/db";
import type {
  CrawlScope,
  OrphansUnknownReason,
  PageClass,
  TruthSource,
} from "@link-graph/db";

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
   * The CMS object this URL came from — a post type slug, a taxonomy slug, or `author`
   * (step 5's provenance, carried through the frontier). **`null` is "unknown", and is
   * never read as content or as non-content**: a flat `sitemap.xml` names nothing, and
   * a discovered URL inherits nothing.
   */
  readonly postType: string | null;
  /**
   * Whether this page is where the crawl's reachability is measured from — the site's
   * homepage. A named fact rather than `depth === 0`, so that a future crawl seeded from
   * a sitemap rather than the homepage cannot silently change what the rule below means.
   */
  readonly isCrawlRoot: boolean;
  /** Inbound internal edges from other pages of this crawl. Self-links excluded. */
  readonly inboundTotal: number;
}

export interface SiteRules {
  /**
   * `null` = not resolved yet, `'none'` = resolved and there is none, `'unreachable'` =
   * the host never answered (step 5). None of the three can answer the orphan question
   * (PRD §2, Undetectable).
   */
  readonly truthSource: TruthSource | null;
  /** `sample` = crawled to a ceiling by policy, so the site was never covered whole. */
  readonly crawlScope: CrawlScope;
  readonly ignorePaths: readonly string[];
  /**
   * Every taxonomy this site registers, as the crawl's own truth resolution found it
   * (`crawls.taxonomies`, `010`). A page whose post type is one of these is a taxonomy
   * archive, which PRD §4 puts in the Excluded class.
   *
   * **Per-site, because the vocabulary is.** Measured on the recorded `/wp/v2/types`
   * responses: integrity.com declares 8 taxonomies and tidewatermg.com 23, and beyond
   * WordPress's own `category`, `post_tag`, `nav_menu` and `wp_pattern_category` the
   * two sets are disjoint — `insights_category` and `wealth_category` against
   * `team-department` and `university-series-taxonomy`. No list written here could know
   * either. Empty means no name is known, and excludes nothing.
   */
  readonly taxonomies: readonly string[];
}

/**
 * Whether this site has an inventory to take the set difference against. Exported
 * because the metrics assembly needs exactly the same test — the rule has one home.
 */
export function hasTruthSource(site: SiteRules): boolean {
  // The rule itself lives beside the column's vocabulary in `@link-graph/db`, because
  // the fixture parser needs the same test — see `isInventory`.
  return isInventory(site.truthSource);
}

/**
 * Why this site's orphan count is unknown, or `null` when it can be counted. One
 * function with two callers — `classifyPage` below and the `crawl_metrics` row in
 * `analyse.ts` — because they must agree about it: a crawl reporting `orphans: null`
 * while its page list reads `orphan` is two answers to one question, and a reader acts
 * on the page list.
 *
 * Order matters: with no truth source there is no inventory to difference against at
 * all, which is the more fundamental gap and the one whose remedy comes first.
 */
export function orphansUnknownReason(site: SiteRules): OrphansUnknownReason | null {
  if (!hasTruthSource(site)) return "no_truth_source";
  if (site.crawlScope === "sample") return "sampled";
  return null;
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
 * The non-content types whose names a plugin or WordPress itself fixes across every
 * site that has them, each with the measurement that put it here.
 *
 * **A WordPress post type is an open set, and an unknown one is treated as content.**
 * That is the direction that cannot silently delete a finding: excluding too much hides
 * real orphans, while including too much leaves a page in the report where a reader can
 * see it and say so. PRD §2's complaint is about phantom orphans, and the fix must not
 * be a rule that quietly removes real ones.
 *
 * Taxonomy archives are deliberately absent: their names are per-site and come from
 * `SiteRules.taxonomies`.
 *
 * A `Set` and not `postType in {...}`: `in` walks the prototype chain, and
 * `constructor`, `toString` and `hasOwnProperty` are all valid WordPress slugs — so the
 * object form would exclude a page called `/toString/` and delete a real orphan with no
 * trace, which is exactly the direction the paragraph above forbids. Not a
 * `satisfies Record<…>` either, unlike `report.ts` and `fetcher-for-mode.ts`: their key
 * type comes from another module, so the check catches a vocabulary that moved. There
 * is no such vocabulary here — a union declared beside this list would only check the
 * list against itself.
 */
const NOT_CONTENT = new Set([
  /**
   * Author archives (PRD §2, §4). The name is Yoast's — `author-sitemap.xml` on
   * tidewatermg.com, whose 4 author archives §2 counts — and WP core's `users` child is
   * normalized to it in `sitemapChild`. `author` is one of WordPress's reserved terms —
   * advisory rather than enforced by `register_post_type`, so this is not a name a site
   * *cannot* use, only one no estate site does: checked on all four recorded type maps.
   */
  "author",
  /**
   * Bricks Builder's templates. 86 of tidewatermg.com's sitemap URLs (PRD §2), and the
   * one child sitemap on that site with no REST post type at all (PRD §4) — so nothing
   * but this name can classify them.
   */
  "bricks_template",
  /**
   * The four GenerateBlocks builder types PRD §4 names, declared by tidewatermg.com's
   * `/wp/v2/types` and absent from its sitemap. REST enumerates them, so their URLs
   * reach the inventory carrying these slugs — which is why they are classified here
   * rather than skipped in `packages/truth`, where they would become invisible.
   */
  "gblocks_condition",
  "gblocks_overlay",
  "gblocks_styles",
  "gblocks_templates",
]);

/**
 * Whether this page is not content at all: a taxonomy archive, an author archive or a
 * page-builder artifact (PRD §4).
 *
 * Measured twice, which is why it is phase-1 work: ~10% of tidewatermg.com's sitemap is
 * one of the three, and integrity.com's live crawl of 2026-08-25 reported nine taxonomy
 * archives among its 538 orphans.
 */
function isNotContent(postType: string | null, site: SiteRules): boolean {
  // Unknown is neither. A page nobody named is left in the orphan question rather than
  // taken out of it (PRD §13: the false positive is visible, the false negative is not).
  if (postType === null) return false;
  return NOT_CONTENT.has(postType) || site.taxonomies.includes(postType);
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
    // PRD §4 puts non-content types in this class by name, and §2 calls the detection
    // phase-1 work. The class is a stretch of §2's wording — a taxonomy archive is not
    // noindex, canonical elsewhere, redirected or ignore-pathed — but §2's Excluded is
    // defined by what it *does*: "counted and shown separately, never in the orphan
    // list", which is exactly right for a page the CMS generated and nobody authored.
    // A separate class value would need a migration, a metrics column and a report line
    // to express a difference no reader would act on differently.
    isNotContent(page.postType, site) ||
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
 *    that has to outrank every answer to it. That now includes PRD §4's non-content
 *    types — a taxonomy archive with inbound links is still not content.
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
 * 5. Then the set difference itself: **any** inbound edge → linked, nothing at all →
 *    orphan. The soft-orphan class between them was dropped on 2026-08-20 (PRD §2):
 *    it produced a measured false positive on 403bplan.net's `/contact-us/`, and its
 *    verdict moved with the crawler's URL-admission policy.
 * 6. Except on a sampled crawl, where "nothing at all" is not a finding. The set
 *    difference is against the *whole* truth source, and a sample never saw it, so an
 *    unlinked-looking page is overwhelmingly likely to be linked from a page the crawl
 *    skipped. One inbound edge still proves `linked` — positive evidence survives
 *    sampling, proving absence does not.
 */
export function classifyPage(page: PageFacts, site: SiteRules): PageClass {
  if (isExcluded(page, site)) return "excluded";
  if (page.isCrawlRoot) return "linked";
  const unknown = orphansUnknownReason(site);
  // With no inventory at all there is nothing to say about this page — not even whether
  // the inventory was supposed to list it, which is why this outranks the next test.
  if (unknown === "no_truth_source") return "undetectable";
  if (!page.inTruthSource) return "not_in_truth_source";
  if (page.inboundTotal > 0) return "linked";
  // The last line is the invariant, not a special case: `orphan` is written onto a page
  // only when this crawl can produce an orphan count, so the page list and the count
  // cannot disagree.
  return unknown === null ? "orphan" : "undetectable";
}
