/**
 * The rows and sentences **both** reports print — `crawl`'s, straight off a run
 * (`report.ts`), and `report`'s, re-read from the database (`site-report.ts`).
 *
 * They exist as one module because the two commands describe the same measurements to
 * the same reader, and PRD §9's whole premise is that "the same number needs two names"
 * — not that one number gets two wordings by accident. Every sentence here is a PRD §2
 * definition or a §1 refusal, so a fix to one of them has to reach both commands: a
 * `crawl` that says "none could be" where `report` says "none" would have a reader
 * comparing two runs and concluding the site changed.
 *
 * Layout lives in `text.ts`; this is the wording, and `orphanListProblem` is the one
 * invariant both read paths share.
 */
import type { CrawlMetricsInput, OrphansUnknownReason } from "@link-graph/db";
import type { TruthSourceKind } from "@link-graph/truth";
import { prosaicRow, row } from "./text.js";

/**
 * The five page classes of PRD §2, as one row.
 *
 * `?` for an unknown orphan count, never 0: the reason is printed in the Orphans row
 * below it, and a zero here would contradict that in the same screenful.
 */
export function pageClassRow(metrics: CrawlMetricsInput): string {
  return row(
    "Pages",
    `${metrics.linked} linked, ${metrics.orphans ?? "?"} orphan, ${metrics.excluded} ` +
      `excluded, ${metrics.notInTruthSource} not in truth source, ` +
      `${metrics.undetectable} undetectable`,
  );
}

/**
 * Why this site's orphan count is unknown, in the words the reader needs — and the
 * remedy, which is the part `crawl_metrics.orphans_unknown_reason` cannot carry.
 *
 * **`no_truth_source` covers two facts with different remedies, and the reason column
 * cannot tell them apart.** `006_truth_source.sql` added `unreachable` to
 * `sites.truth_source` precisely because "we asked and there is no inventory" and "the
 * host never answered" are different — `agents.integrity.com` has no DNS and
 * `integritymedicarehelpline.com` refuses connections, while both hold live configs
 * (PRD §3.1). Printing "the remedy is a truth source, not a crawl" at a dead host sends
 * the reader after a content decision for a deployment fault, so the sentence is chosen
 * from the resolved kind, which does distinguish them.
 */
export function unknownReasonSentence(
  reason: OrphansUnknownReason,
  truthKind: TruthSourceKind,
): string {
  if (reason === "sampled") {
    return (
      "this crawl covered a page ceiling rather than the whole site, by policy " +
      "(PRD §15), so a page with no inbound link may simply be linked from one the " +
      "crawl skipped. Deliberate, and not a coverage failure — broken links and " +
      "structure below still hold."
    );
  }
  if (truthKind === "unreachable") {
    // Deliberately not "the host is down". A host that answers nothing produces a crawl
    // with no pages, which is `partial`, which throws — so this sentence can only ever
    // be read beside a page count above it. What actually happened is narrower and more
    // useful: the truth-source paths did not answer while the site did.
    return (
      "nothing answered on this host's truth-source paths — /wp-json/ and the sitemap " +
      "candidates — so no inventory was resolved either way, while the pages counted " +
      "above served normally. A WAF or a blocked REST route, not a site with nothing " +
      "published, and not zero orphans."
    );
  }
  return (
    "this site has no inventory to take the set difference against, so the orphan " +
    "question cannot be answered here at all. A coverage gap (PRD §2), not zero " +
    "orphans — the remedy is a truth source, not a crawl."
  );
}

/** The Orphans row of a crawl that could not answer the question (PRD §2). */
export const unknownOrphansRow = (
  reason: OrphansUnknownReason,
  truthKind: TruthSourceKind,
): string =>
  prosaicRow(
    "Orphans",
    `unknown — ${reason}: ${unknownReasonSentence(reason, truthKind)}`,
  );

/**
 * The Orphans row when the count is a genuine zero **and no page was ever assessed**.
 *
 * Zero orphans has two causes and they are not the same news. Measured 2026-08-25 on
 * integrity-2024.staging02.imgwebhost.com, where every page carries
 * `<meta name=robots content='noindex, nofollow'>`: every page is then Excluded — the
 * crawl root included, since Excluded outranks the crawl-root rule — so `linked` is 0
 * and the orphan question was never asked of a single URL. Saying "every URL has an
 * inbound link" there is false, and false in the direction that reads as good news.
 */
export const nothingAssessedRow = (metrics: CrawlMetricsInput): string =>
  prosaicRow(
    "Orphans",
    `none found, and none could be: no page of the truth source was assessed. ` +
      `${metrics.excluded} page(s) are excluded — noindex, a canonical pointing ` +
      `elsewhere, a redirect, an ignore_paths match, or a non-content type such as a ` +
      `taxonomy or author archive (PRD §2, §4) — so the orphan question was asked of ` +
      `nothing. A site-wide noindex, as staging environments carry, produces exactly ` +
      `this`,
  );

/**
 * The Orphans row when the count is a genuine zero and pages **were** assessed.
 *
 * "every URL in the truth source" would be false whenever anything was excluded — and
 * since `010` that includes every taxonomy and author archive, which is most WordPress
 * sites. The question was asked of the pages that were assessed, and the count of the
 * ones it was not asked of belongs in the same sentence.
 */
export const allAssessedLinkedRow = (metrics: CrawlMetricsInput): string =>
  prosaicRow(
    "Orphans",
    `none — every URL assessed has at least one inbound internal link` +
      (metrics.excluded === 0
        ? ""
        : ` (${metrics.excluded} excluded page(s) were not assessed)`),
  );

/** PRD §2's definition of the thing being listed, over both reports' orphan tables. */
export const orphanTableTitle = (count: number): string =>
  `Orphans — in the truth source, published, indexable, and nothing on this site ` +
  `links to them (${count}):`;

/**
 * A status cell. "-" rather than a blank: a page row with no status was never fetched,
 * and an empty cell reads as a formatting accident rather than as a fact.
 */
export const statusCell = (code: number | null): string =>
  code === null ? "-" : `${code}`;

/**
 * Whether the orphan count and the orphan list disagree, as a sentence, or `null`.
 *
 * Two answers to one question: `crawl_metrics.orphans` is what step 12's dashboard will
 * read and the list is what a person acts on, so if they differ there is no way to tell
 * which is right and neither may be printed.
 */
export function orphanListProblem(
  metrics: Pick<CrawlMetricsInput, "orphans" | "orphansUnknownReason">,
  listed: number,
): string | null {
  if (metrics.orphans === null) {
    if (listed > 0) {
      return (
        `its orphan count is unknown (${metrics.orphansUnknownReason ?? "no reason"}) ` +
        `and yet ${listed} page(s) are classified orphan. The count and the page list ` +
        `are two answers to one question, and a reader acts on the list`
      );
    }
    return null;
  }
  return listed === metrics.orphans
    ? null
    : `it counts ${metrics.orphans} orphan(s) and lists ${listed}. One of the two is ` +
        `wrong and nothing here can say which`;
}
