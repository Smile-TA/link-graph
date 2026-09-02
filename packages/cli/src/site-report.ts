/**
 * What `link-graph report <site-id>` prints: one site's last complete crawl, with its
 * findings split by review state. Pure — a model in, text out, the clock injected.
 *
 * **The measured numbers come first and are printed whatever the reviews say.** That is
 * PRD §7.1 rule 1, and it is the whole reason this file is not allowed to be clever: a
 * report where every orphan has been judged must read "538 orphans, 538 reviewed" and
 * never "no orphans", because a suppressed finding that reads like an absent one is
 * engineering guide §1 pointing the wrong way. So the three bucket counts are printed
 * beside the measured total, always, all three, even at zero. The total printed is the
 * length of the finding list, which `siteReportProblem` has already refused unless it
 * equals `crawl_metrics.orphans` — the count and the list are checked against each other
 * before either is printed, rather than one being derived from the other.
 *
 * The tables are PRD §9's: sorted, split three ways, and the place a note gets written.
 */
import type { CrawlMetricsInput, TruthSource } from "@link-graph/db";
import {
  countBuckets,
  countStates,
  REVIEW_BUCKETS,
  type BrokenLinkEvidence,
  type OrphanEvidence,
  type ReviewBucket,
  type ReviewedFinding,
} from "@link-graph/review";
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

export interface SiteReport {
  readonly siteId: string;
  readonly canonicalHost: string;
  /**
   * `sites.truth_source`. Read only to choose which of PRD §2's sentences an unknown
   * orphan count gets: "we asked and there is no inventory" and "the host never
   * answered" have different remedies (`006_truth_source.sql`).
   */
  readonly truthSource: TruthSource | null;
  readonly crawl: {
    readonly finishedAt: Date | null;
    /** Page and link rows counted in the tables, not the crawl's own `pages_seen`. */
    readonly pages: number;
    readonly links: number;
    readonly truthSourceUrls: number | null;
    /**
     * `crawls.was_throttled`. Carried because a throttled crawl is one whose 503s cost
     * it pages, and pages it never fetched are inbound edges it never saw — which
     * inflates the very orphan list this report re-prints. The crawl command says so on
     * its own Crawl row; dropping it here would leave the degradation printed once and
     * then quietly lost (engineering guide §1).
     */
    readonly wasThrottled: boolean;
  };
  /** Exactly as `analyse` committed it. Nothing here recomputes a number. */
  readonly metrics: CrawlMetricsInput;
  /** Empty whenever `metrics.orphans` is null — see `siteReportProblem`. */
  readonly orphans: readonly ReviewedFinding<OrphanEvidence>[];
  readonly brokenLinks: readonly ReviewedFinding<BrokenLinkEvidence>[];
}

/** The label each bucket is printed under (PRD §9's three-way split). */
const BUCKET_LABEL = {
  new: "new",
  changed: "changed since review",
  reviewed: "reviewed",
} satisfies Record<ReviewBucket, string>;

/**
 * What is wrong with this report, or `null`. The same two-answers-to-one-question test
 * the crawl report applies, plus the one the stored path adds.
 *
 * Unlike the crawl report's version these are *reachable*: the numbers and the classified
 * pages are read back separately, from a crawl that could have been analysed by an
 * older build of `analyse`, and the broken-edge count and the broken-target list come
 * from two different queries.
 */
export function siteReportProblem(report: SiteReport): string | null {
  const { metrics, brokenLinks } = report;
  const disagreement = orphanListProblem(metrics, report.orphans.length);
  if (disagreement !== null) return disagreement;

  // The five class counts account for every page row of the crawl, which is the check
  // `reportProblem` makes on the crawl path — reachable here, where the counts and the
  // rows are two separate reads. A page short means a page whose class was never
  // written, and an unclassified page is one the orphan question was not asked about.
  const classified =
    metrics.linked +
    (metrics.orphans ?? 0) +
    metrics.excluded +
    metrics.notInTruthSource +
    metrics.undetectable;
  if (classified !== report.crawl.pages) {
    return (
      `its class counts account for ${classified} page(s) and the crawl has ` +
      `${report.crawl.pages} page row(s). Every page carries exactly one class, so one ` +
      `of the two is wrong`
    );
  }
  // `crawl_metrics.broken` counts broken internal *edges* and the table below lists
  // their *targets*, so the two numbers differ legitimately — one page can link to the
  // same 404 twice. What cannot happen is one being zero while the other is not, or
  // more distinct linking pages than there are edges for them to link with.
  if ((metrics.broken === 0) !== (brokenLinks.length === 0)) {
    return (
      `it counts ${metrics.broken} broken internal edge(s) and lists ` +
      `${brokenLinks.length} broken target(s). One of the two queries is wrong and ` +
      `nothing here can say which`
    );
  }
  const linkingPages = brokenLinks.reduce(
    (total, finding) => total + finding.finding.evidence.blastRadius,
    0,
  );
  if (linkingPages > metrics.broken) {
    return (
      `its broken targets are linked from ${linkingPages} page(s) in total, over ` +
      `${metrics.broken} broken edge(s) — every linking page needs an edge, so the ` +
      `blast radii and the edge count cannot both be right`
    );
  }
  return null;
}

export function formatSiteReport(report: SiteReport, now: Date): string {
  const { crawl, metrics } = report;
  const inventory =
    crawl.truthSourceUrls === null ? "" : ` of a ${crawl.truthSourceUrls}-URL inventory`;
  const lines = [
    row("Site", `${report.siteId}  ${report.canonicalHost}`),
    row(
      "Crawl",
      `#${metrics.crawlId} — ${crawl.pages} page(s)${inventory}, ${crawl.links} link(s)`,
    ),
    row("Finished", finished(crawl.finishedAt, now)),
    ...(crawl.wasThrottled
      ? [
          prosaicRow(
            "Throttled",
            `the host blocked this crawl at least once (PRD §5.1), so it may have ` +
              `missed pages — and a page it never fetched is an inbound link it never ` +
              `saw. Treat the orphan list below as a ceiling, not a count`,
          ),
        ]
      : []),
    pageClassRow(metrics),
    row(
      "Links",
      `${metrics.broken} broken internal edge(s), ${metrics.internalUnresolved} ` +
        `internal unresolved, ${metrics.external} external`,
    ),
    orphanSummary(report),
    summary("Broken links", report.brokenLinks, " target(s)"),
  ];

  if (report.orphans.length > 0) {
    lines.push(
      "",
      ...table(
        orphanTableTitle(report.orphans.length),
        `  ${"#".padStart(3)}  ${"status".padStart(6)}`,
        report.orphans,
        (finding) => statusCell(finding.evidence.statusCode).padStart(6),
        now,
      ),
    );
  }
  if (report.brokenLinks.length > 0) {
    lines.push(
      "",
      ...table(
        `Broken internal links — the target served an error, and the blast radius is ` +
          `how many distinct pages link to it (${report.brokenLinks.length}):`,
        `  ${"#".padStart(3)}  ${"status".padStart(6)}  ${"pages".padStart(5)}`,
        report.brokenLinks,
        (finding) =>
          `${String(finding.evidence.statusCode).padStart(6)}  ` +
          `${String(finding.evidence.blastRadius).padStart(5)}`,
        now,
      ),
    );
  }

  // Said on every report rather than only when it bites, because it is a permanent
  // property of re-reading stored numbers rather than a per-run status: `crawl` decides
  // whether its inventory was whole from step 5's findings, and nothing stores those, so
  // this command cannot reach that verdict at all (PRD §15). A reader comparing an
  // exit 0 here with an exit 3 there has to be able to see why.
  lines.push(
    "",
    indented(
      `crawl #${metrics.crawlId}'s stored numbers, re-read rather than re-measured. ` +
        `Whether its inventory was short of the site is computed per run and stored ` +
        `nowhere (PRD §15), so a crawl that exited 3 because a truth source went ` +
        `unread is re-read here as an exit 0. Run \`link-graph crawl ` +
        `${report.siteId}\` for that verdict.`,
      "Note: ",
      "      ",
    ),
  );
  // No trailing newline: `Io.out` writes one line, and the caller ends it.
  return lines.join("\n");
}

/**
 * The crawl's age, which is the first thing a reader of a stored report needs: numbers
 * from a crawl three months old are a different statement about the site.
 */
function finished(at: Date | null, now: Date): string {
  // A `complete` crawl with no `finished_at` can only come from a fixture (`finishCrawl`
  // requires one), and saying so is better than printing "Invalid Date".
  if (at === null) return "not recorded — this crawl was loaded, not run";
  return `${at.toISOString()}, ${days(at, now)} day(s) ago`;
}

/**
 * Whole days, floored, and deliberately not clamped at zero: a review or a crawl dated
 * in the future is a clock problem, and "-3 day(s)" is visibly wrong where a 0 would
 * read as "today".
 */
function days(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/** The line the whole command exists to print. */
function orphanSummary(report: SiteReport): string {
  const { metrics } = report;
  if (metrics.orphansUnknownReason !== null) {
    return unknownOrphansRow(
      metrics.orphansUnknownReason,
      // `null` is "never resolved", which only a loaded fixture can pair with an
      // analysed crawl — `crawl` writes the column before crawling. "none" is the
      // closest true sentence: no inventory was recorded for this site.
      report.truthSource ?? "none",
    );
  }
  if (metrics.orphans === 0 && metrics.linked === 0) return nothingAssessedRow(metrics);
  // A genuine zero, in the same words `crawl` uses for it. Printing a bare "0 — 0 new,
  // 0 changed, 0 reviewed" here would leave the excluded-page aside off the one report
  // a reader re-reads, and have them comparing two runs and concluding the site moved.
  if (metrics.orphans === 0) return allAssessedLinkedRow(metrics);
  return summary("Orphans", report.orphans, "");
}

/**
 * `<label>  <total><unit> — a new, b changed since review, c reviewed (d intentional,
 * e acknowledged)`.
 *
 * All three bucket counts, always (PRD §9), and in `REVIEW_BUCKETS` order rather than
 * written out — a fourth bucket then prints rather than being silently dropped from the
 * line. The state split is printed only when something is reviewed, following this
 * command's rule that a line reading "0 of each" on every ordinary run is a line nobody
 * reads on the run where it matters.
 */
function summary(
  label: string,
  findings: readonly ReviewedFinding[],
  unit: string,
): string {
  const buckets = countBuckets(findings);
  const states = countStates(findings);
  const split =
    buckets.reviewed === 0
      ? ""
      : ` (${states.intentional} intentional, ${states.acknowledged} acknowledged)`;
  const counts = REVIEW_BUCKETS.map(
    (bucket) => `${buckets[bucket]} ${BUCKET_LABEL[bucket]}`,
  ).join(", ");
  return row(label, `${findings.length}${unit} — ${counts}${split}`);
}

/**
 * One finding table, in three sections. Every section is printed even when it is empty,
 * because "0 changed since review" is a fact a reader wants and an absent heading is
 * one they have to infer.
 *
 * The row numbers run continuously across the sections, so the last one is the measured
 * total. That is deliberate: it puts PRD §7.1 rule 1 in front of the reader, rather
 * than three lists that have to be added up.
 */
function table<E extends OrphanEvidence | BrokenLinkEvidence>(
  title: string,
  header: string,
  findings: readonly ReviewedFinding<E>[],
  cells: (finding: { readonly evidence: E }) => string,
  now: Date,
): string[] {
  const lines = [title, "", `${header}  URL`];
  const indent = " ".repeat(header.length + 2);
  let number = 0;
  for (const bucket of REVIEW_BUCKETS) {
    const rows = findings.filter((finding) => finding.bucket === bucket);
    lines.push(`  ${BUCKET_LABEL[bucket]} (${rows.length})`);
    if (rows.length === 0) lines.push(`    (none)`);
    for (const finding of rows) {
      number += 1;
      lines.push(
        `  ${String(number).padStart(3)}  ${cells(finding.finding)}  ` +
          `${finding.finding.subject}`,
      );
      const judgement = reviewLine(finding, now);
      if (judgement !== null) lines.push(indented(judgement, indent, indent));
    }
  }
  return lines;
}

/**
 * The review under its finding: what it claimed, who claimed it, and **how old it is**.
 * The age is required by PRD §7.1, which leaves disappeared-then-returned detection to
 * step 13 and asks for the age in the meantime, so that a two-year-old acknowledgement
 * is visible rather than invisible.
 */
function reviewLine(finding: ReviewedFinding, now: Date): string | null {
  const { review, bucket } = finding;
  if (review === null) return null;
  const age = `${days(review.reviewedAt, now)} day(s) ago by ${review.reviewedBy}`;
  return bucket === "changed"
    ? `the evidence has moved since it was judged ${review.state} ${age}: ${review.note}`
    : `${review.state}, judged ${age}: ${review.note}`;
}
