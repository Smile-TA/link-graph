/**
 * What a person reads. Pure: a model in, text out, no I/O and no clock.
 *
 * **The output is the deliverable of this step, not a side effect of it.** PRD §13 puts
 * it plainly — "an orphan report that is 30% noise gets ignored within two weeks" — so
 * every rule below is about the reader being able to tell an answer from the absence of
 * one:
 *
 * - a count of orphans is printed only when this crawl could take the set difference;
 * - when it could not, the reason is printed in the count's place, never a zero
 *   (PRD §2's Undetectable, engineering guide §1);
 * - a site with a genuine zero says so in words, so that "none" and "unknown" cannot be
 *   confused at a glance;
 * - the degradations step 5 computes and nothing stores are printed rather than dropped.
 */
import { isInventory } from "@link-graph/db";
import {
  allAssessedLinkedRow,
  nothingAssessedRow,
  orphanListProblem,
  orphanTableTitle,
  pageClassRow,
  statusCell,
  unknownOrphansRow,
} from "./report-rows.js";
import { indented, prosaicRow, row } from "./text.js";
import type { CrawlMetricsInput, TruthSource } from "@link-graph/db";
import type { TruthFinding, TruthFindingKind, TruthSourceKind } from "@link-graph/truth";

export interface OrphanRow {
  readonly urlNormalized: string;
  /** `null` = the page was never fetched, which is not the same as 200. */
  readonly statusCode: number | null;
}

/**
 * Whether these findings mean the inventory the orphan set difference was taken against
 * is **provably short of the site** — decided 2026-08-25 (PRD §15).
 *
 * The split is by what each finding means, not by severity in the abstract. A source
 * that could not be read leaves URLs nobody enumerated, and a page missing from the
 * inventory cannot appear in the difference, so an orphan on it is unreportable. Two
 * sources that were both read and merely disagree leave no such hole: that disagreement
 * is `sitemap-invisible` arithmetic (PRD §2), an axis orthogonal to the orphan question.
 *
 * Exhaustive by construction: `satisfies Record<TruthFindingKind, …>` makes a finding
 * kind added to `packages/truth` a compile error here rather than a silent `intact`,
 * which is the direction that would quietly restore the 0 this rule exists to stop.
 */
const INVENTORY = {
  /** REST answered but was blocked or malformed — nobody knows what it would list. */
  "rest-unusable": "short",
  /** Enumeration began and could not finish, so what it did not reach is unknown. */
  "rest-incomplete": "short",
  /** `X-WP-Total` and the URLs pagination yielded disagree: some were never seen. */
  "rest-total-mismatch": "short",
  /** A child sitemap could not be read, so its URLs are missing from the inventory. */
  "sitemap-incomplete": "short",
  /** A site with nothing published. Read successfully; there was nothing to list. */
  "rest-empty": "intact",
  /**
   * The content was read and only the status was recorded — step 5's measured rule.
   * `wp-sitemap-posts-page-30.xml` answers 404 with a valid 1,363-URL urlset, so a
   * degraded status says nothing about completeness.
   */
  "sitemap-degraded": "intact",
  /** Both sources read, and they disagree. Orthogonal to the orphan question (PRD §2). */
  "sitemap-invisible": "intact",
  "rest-missing": "intact",
  /** URLs the inventory should not have listed: off-site, or not a crawlable page. */
  "dropped-url": "intact",
  "duplicate-url": "intact",
} satisfies Record<TruthFindingKind, "short" | "intact">;

export function inventoryIsProvablyIncomplete(
  findings: readonly TruthFinding[],
): boolean {
  return findings.some((finding) => INVENTORY[finding.kind] === "short");
}

export interface CrawlReport {
  readonly siteId: string;
  readonly canonicalHost: string;
  readonly truth: {
    readonly kind: TruthSourceKind;
    /** What `sites.truth_source` said before this run, for the "changed" note. */
    readonly registryWas: TruthSource | null;
    readonly inventory: number | null;
    readonly rest: number | null;
    readonly sitemap: number | null;
    readonly requests: number;
    readonly findings: readonly TruthFinding[];
  };
  readonly crawl: {
    readonly crawlId: number;
    readonly pages: number;
    readonly links: number;
    readonly aliasHops: number;
    readonly wasThrottled: boolean;
    /**
     * Frontier entries with no page row. Zero on a full crawl that finished — a partial
     * one never reaches this report — and the size of the shortfall on a sampled one.
     */
    readonly pending: number;
  };
  readonly metrics: CrawlMetricsInput;
  /** The orphan pages themselves. Empty whenever `metrics.orphans` is null. */
  readonly orphans: readonly OrphanRow[];
}

/**
 * What is wrong with this report, as a sentence, or `null` if nothing is.
 *
 * Each check compares two facts that were derived independently and must agree. The
 * table is what a person acts on and `crawl_metrics` is what step 12's dashboard will
 * read; if they disagree there is no way to tell which is right, so neither is printed.
 *
 * These are unreachable by construction today — `analyse` derives the count and the
 * classes from one `orphansUnknownReason` call, and the CLI writes `sites.truth_source`
 * before crawling. They are here because the consequence of the construction changing is
 * a wrong orphan table rather than a missing one, and because nothing else compares the
 * resolution with the metrics row. Note what a trigger does NOT undo: `analyse` has
 * already committed, so the numbers stay in the database even though none is printed.
 */
export function reportProblem(report: CrawlReport): string | null {
  const { metrics, orphans } = report;
  const disagreement = orphanListProblem(metrics, orphans.length);
  if (disagreement !== null) return disagreement;

  // Every page of a crawl carries exactly one class, so the five counts account for the
  // whole page set. A page short means a page whose class was never written — and an
  // unclassified page is one the orphan question was silently not asked about.
  const classified =
    metrics.linked +
    (metrics.orphans ?? 0) +
    metrics.excluded +
    metrics.notInTruthSource +
    metrics.undetectable;
  if (classified !== report.crawl.pages) {
    return (
      `its class counts account for ${classified} page(s) and the crawl fetched ` +
      `${report.crawl.pages}. Every page carries exactly one class, so one of the two ` +
      `is wrong`
    );
  }

  // The resolution and the metrics row are two independent statements about whether this
  // site has an inventory. "No truth source" beside a resolution that read one means the
  // `sites.truth_source` write did not happen, and the orphan count would then be unknown
  // for a site whose inventory is sitting in `crawls.truth_source_urls`.
  //
  // `isInventory` rather than a fourth spelling of "rest or sitemap": the predicate lives
  // beside the vocabulary in `@link-graph/db` precisely so that a fifth `TRUTH_SOURCES`
  // value cannot be an inventory in three places and not in a fourth. Assigning a
  // `TruthSourceKind` to its `TruthSource` parameter is the seam `packages/truth`
  // describes — a value in one list and not the other is a compile error here.
  if (
    metrics.orphansUnknownReason === "no_truth_source" &&
    isInventory(report.truth.kind)
  ) {
    return (
      `its orphan count is unknown for want of a truth source, but the resolution found ` +
      `one (${report.truth.kind}, ${report.truth.inventory ?? "?"} URL(s)). The site row ` +
      `and the crawl disagree about whether this site can be checked at all`
    );
  }
  return null;
}

export function formatReport(report: CrawlReport): string {
  const { truth, metrics } = report;
  const lines = [
    row("Site", `${report.siteId}  ${report.canonicalHost}`),
    row("Truth source", truthSource(report)),
    row("Crawl", crawlLine(report)),
    pageClassRow(metrics),
    row(
      "Links",
      `${metrics.broken} broken, ${metrics.internalUnresolved} internal unresolved, ` +
        `${metrics.external} external (boilerplate N = ${metrics.boilerplateThresholdPct}%)`,
    ),
    row(
      "Unreachable",
      `${metrics.unreachable} page(s) with no path from the homepage over the edges ` +
        `this crawl saw`,
    ),
    orphanSummary(report),
  ];
  if (truth.findings.length > 0) {
    lines.push(
      "",
      `Truth-source findings (${truth.findings.length}) — the orphan table is only as ` +
        `complete as the inventory it was differenced against:`,
    );
    for (const finding of truth.findings) {
      lines.push(indented(`${finding.kind}: ${finding.detail}`, "  ", "    "));
    }
  }
  if (report.orphans.length > 0) lines.push("", ...orphanTable(report.orphans));
  // No trailing newline: `Io.out` writes one line, and the caller ends it.
  return lines.join("\n");
}

function truthSource(report: CrawlReport): string {
  const { kind, registryWas, inventory, rest, sitemap, requests } = report.truth;
  const size =
    inventory === null
      ? "no inventory"
      : `${inventory} URL(s) (REST ${count(rest)}, sitemap ${count(sitemap)})`;
  // Only when it moved: a line that says "unchanged" on every ordinary run is a line
  // nobody reads on the run where it changed.
  const changed =
    kind === registryWas
      ? ""
      : `, registry updated from ${registryWas === null ? "unresolved" : registryWas}`;
  return `${kind} — ${size} in ${requests} request(s)${changed}`;
}

const count = (value: number | null): string =>
  value === null ? "not read" : `${value}`;

function crawlLine(report: CrawlReport): string {
  const { crawl, truth } = report;
  const of = truth.inventory === null ? "" : ` of a ${truth.inventory}-URL inventory`;
  const hops = crawl.aliasHops === 0 ? "" : `, ${crawl.aliasHops} alias hop(s)`;
  // A sampled crawl is `complete` and still leaves part of the inventory unfetched
  // (PRD §15). Saying "complete" without saying that reads as "the whole site", which
  // the Orphans row then contradicts several lines further down.
  const unfetched =
    crawl.pending === 0 ? "" : `, ${crawl.pending} queued URL(s) never fetched`;
  // Said only when it happened. "not throttled" on every run is noise, and a reader
  // scanning for the word would find it on the runs where nothing was blocked.
  const throttled = crawl.wasThrottled
    ? ", throttled by the host at least once — the rate limit needs looking at"
    : "";
  return (
    `#${crawl.crawlId} complete — ${crawl.pages} page(s)${of}${unfetched}, ` +
    `${crawl.links} link(s)${hops}${throttled}`
  );
}

/** The line the whole command exists to print. */
function orphanSummary(report: CrawlReport): string {
  const { orphans, orphansUnknownReason } = report.metrics;
  if (orphansUnknownReason !== null) {
    return unknownOrphansRow(orphansUnknownReason, report.truth.kind);
  }
  // Exit 3 is returned for this case (`exit.ts`), so the line a person reads must not
  // claim more than the code does. "none" in particular would be a clean bill of health
  // for a site whose inventory nobody finished reading.
  if (inventoryIsProvablyIncomplete(report.truth.findings)) {
    return prosaicRow(
      "Orphans",
      `${orphans} of an inventory that is short of the site — a source could not be ` +
        `read, so a page missing from the inventory cannot appear in this count. See ` +
        `the findings below`,
    );
  }
  if (orphans === 0 && report.metrics.linked === 0) {
    return nothingAssessedRow(report.metrics);
  }
  if (orphans === 0) return allAssessedLinkedRow(report.metrics);
  return row("Orphans", `${orphans} — listed below`);
}

function orphanTable(orphans: readonly OrphanRow[]): string[] {
  const lines = [
    orphanTableTitle(orphans.length),
    "",
    `  ${"#".padStart(3)}  ${"status".padStart(6)}  URL`,
  ];
  for (const [index, orphan] of orphans.entries()) {
    lines.push(
      `  ${String(index + 1).padStart(3)}  ` +
        `${statusCell(orphan.statusCode).padStart(6)}  ${orphan.urlNormalized}`,
    );
  }
  return lines;
}
