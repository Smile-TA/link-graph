/**
 * `link-graph note <site-id> <kind> <subject> --intentional|--acknowledged -m <note>`:
 * one human judgement, written down.
 *
 *     registry row → node identity for the subject → the latest complete crawl's
 *                  → findings of that kind → the finding's evidence → one upsert
 *
 * **The subject has to be a finding of the last crawl, and this refuses when it is
 * not.** Two reasons, and the first is engineering guide §1: a typo in a URL would
 * otherwise store a review nothing matches, print "noted", and leave the real finding
 * ranked as new every week — a failure wearing a success. The second is that rule 5's
 * digest is taken over *current* evidence, so a review of something nobody measured has
 * nothing to be a review of.
 *
 * It writes exactly one row, to one table nothing else reads. `crawl_metrics` and
 * `pages.class` are not touched, which is PRD §7.1 rule 1.
 */
import { normalizeUrl } from "@link-graph/core";
import {
  findCrawlMetrics,
  findFindingReview,
  findLatestCompleteCrawl,
  listBrokenLinkFindings,
  listOrphanFindings,
  upsertFindingReview,
  type FindingKind,
  type FindingReviewRow,
  type ReviewState,
  type SiteRow,
} from "@link-graph/db";
import {
  brokenLinkFinding,
  evidenceDigest,
  orphanFinding,
  type Finding,
} from "@link-graph/review";
import type { Pool } from "pg";
import { UsageError } from "./exit.js";
import { siteBySlug } from "./registry.js";
import { indented } from "./text.js";

export interface NoteRequest {
  /** The `sites.site_id` slug, as typed. */
  readonly siteId: string;
  readonly finding: FindingKind;
  /** As typed: a path or an absolute URL, resolved to node identity here. */
  readonly subject: string;
  readonly state: ReviewState;
  readonly note: string;
  /** `--by`, or `$USER`. Resolved by `main`, which is the only thing with an env. */
  readonly reviewedBy: string;
}

export interface NoteOutcome {
  readonly review: FindingReviewRow;
  /** The judgement this one replaced, or `null`. Printed, never silently dropped. */
  readonly replaced: FindingReviewRow | null;
  /** The crawl whose evidence the digest was taken over. */
  readonly crawlId: number;
}

export async function runNoteCommand(
  pool: Pool,
  request: NoteRequest,
  now: Date,
): Promise<NoteOutcome> {
  const site = await siteBySlug(pool, request.siteId);
  const subject = nodeIdentity(site, request.subject);
  const crawl = await findLatestCompleteCrawl(pool, site.id);
  if (crawl === null) {
    throw new Error(
      `no complete crawl of ${site.siteId}, so it has no findings to judge. Run ` +
        `\`link-graph crawl ${site.siteId}\` first`,
    );
  }

  // **A crawl `report` refuses, `note` refuses too, and for the same reason.** `analyse`
  // throws *after* `finishCrawl` has written `status = 'complete'` — its coverage gate,
  // its fetched-nothing and its unmarked-links refusals all fire there — so a complete
  // crawl with no metrics row and `pages.class` NULL is a state real runs produce. Left
  // to itself the code below would find no orphan rows and blame the operator's URL:
  // "not one of the 0 orphan finding(s)", exit 1, "nothing is wrong with the estate".
  const metrics = await findCrawlMetrics(pool, crawl.id);
  if (metrics === null) {
    throw new Error(
      `crawl ${crawl.id} of ${site.siteId} has no crawl_metrics row, so \`analyse\` ` +
        `has never run over it: its pages carry no class and it has no findings to ` +
        `judge yet. That is a refused or unfinished analysis, not a wrong URL`,
    );
  }
  // The same rule one class down: on a site with no truth source or a sampled crawl,
  // `analyse` classifies every candidate `undetectable` and writes `orphans: null`, so
  // the orphan list is empty **by design and permanently**. "0 orphan finding(s)" there
  // would read as "this site has no orphans" (PRD §2, Undetectable).
  if (request.finding === "orphan" && metrics.orphansUnknownReason !== null) {
    throw new Error(
      `crawl ${crawl.id} of ${site.siteId} could not answer the orphan question ` +
        `(${metrics.orphansUnknownReason}), so it has no orphan findings to judge — a ` +
        `coverage gap, never zero orphans (PRD §2). Its broken internal links are ` +
        `still reviewable`,
    );
  }

  const findings = await findingsOfKind(pool, crawl.id, request.finding);
  const finding = findings.find((candidate) => candidate.subject === subject);
  if (finding === undefined) {
    throw new UsageError(
      `${subject} is not one of the ${findings.length} ${request.finding} finding(s) ` +
        `of crawl ${crawl.id} of ${site.siteId}, so there is nothing here to review. ` +
        `\`link-graph report ${site.siteId}\` lists them; a review of something this ` +
        `crawl did not find would sit in the table matching nothing`,
    );
  }

  // Two statements, not one transaction: the "replaced X's review" line is read a
  // round trip before the upsert writes. Two people judging one finding at the same
  // second could both be told they replaced the same earlier review. A CLI one person
  // runs is not that race, and collapsing it needs a CTE returning the pre-update row —
  // recorded rather than built, because the line it protects is only ever read by the
  // person who just typed the command.
  const replaced = await findFindingReview(pool, site.id, request.finding, subject);
  const review = await upsertFindingReview(pool, {
    siteId: site.id,
    kind: request.finding,
    subject,
    state: request.state,
    note: request.note,
    evidenceDigest: evidenceDigest(finding.evidence),
    reviewedBy: request.reviewedBy,
    reviewedAt: now,
  });
  return { review, replaced, crawlId: crawl.id };
}

/**
 * The findings of one kind, which is the read `report` does. Exhaustive by return type:
 * a third `FindingKind` leaves this function without an ending return and fails to
 * compile, rather than making that kind's findings unreviewable.
 */
async function findingsOfKind(
  pool: Pool,
  crawlId: number,
  kind: FindingKind,
): Promise<Finding[]> {
  switch (kind) {
    case "orphan":
      return (await listOrphanFindings(pool, crawlId)).map(orphanFinding);
    case "broken_internal_link":
      return (await listBrokenLinkFindings(pool, crawlId)).map(brokenLinkFinding);
  }
}

/**
 * What the person typed, as the identity the crawl stored.
 *
 * `normalizeUrl` and not a string compare, because `pages.url_normalized` is what
 * `normalizeUrl` produced: `/agents/thank-you` and `/agents/thank-you/` are the same
 * page to WordPress and two different strings, and a review keyed on the unslashed form
 * would match nothing forever (PRD §7 on why normalization is its own package).
 */
function nodeIdentity(site: SiteRow, subject: string): string {
  const url = normalizeUrl(subject, {
    canonicalHost: site.canonicalHost,
    aliases: site.aliases,
  });
  if (url === null) {
    throw new UsageError(
      `${JSON.stringify(subject)} is not a crawlable URL, so no finding can be about ` +
        `it. Give a path such as /agents/thank-you/ or an absolute URL on ` +
        `${site.canonicalHost}`,
    );
  }
  if (!url.isInternal) {
    // An external URL is somebody else's page. Broken *external* links are step 8's,
    // and they are not a `FindingKind` here, so this cannot be a subject at all.
    throw new UsageError(
      `${url.href} is not on ${site.siteId} (${site.canonicalHost} and ` +
        `${site.aliases.length} alias(es)), so it is not a finding of that site`,
    );
  }
  return url.href;
}

/** The width of "noted: ", so a wrapped line continues under the first one. */
const INDENT = "       ";

/**
 * The confirmation, on stdout: what was written, against what evidence, and whose
 * judgement it replaced.
 *
 * The replacement line is the one that matters. An upsert that silently overwrote
 * somebody else's note would be a loss that looks exactly like a success, and this is
 * the only place it can be said.
 */
export function formatNoteOutcome(outcome: NoteOutcome): string {
  const { review, replaced } = outcome;
  const lines = [
    // Wrapped like every other line this command prints: a note is free text, and a
    // long one would otherwise run past the width the reports keep to.
    indented(
      `noted: ${review.kind} ${review.subject} — ${review.state} by ` +
        `${review.reviewedBy}: ${review.note}`,
      "",
      INDENT,
    ),
    indented(
      `judged against crawl #${outcome.crawlId}'s evidence; if that moves, the finding ` +
        `re-surfaces as "changed since review"`,
      INDENT,
      INDENT,
    ),
  ];
  if (replaced !== null) {
    lines.push(
      indented(
        `replaced ${replaced.reviewedBy}'s ${replaced.state} review of ` +
          `${replaced.reviewedAt.toISOString()}: ${replaced.note}`,
        INDENT,
        INDENT,
      ),
    );
  }
  return lines.join("\n");
}
