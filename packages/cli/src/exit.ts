/**
 * The exit code is part of this command's contract, because it is the only part a cron
 * job or a CI step reads.
 *
 * Engineering guide §1 in its most literal form: **a run that found nothing because it
 * fetched nothing must never exit 0.** Every way this command can fail to answer the
 * orphan question has its own non-zero code, so that a caller can tell "the site is
 * clean" from "the site could not be checked" without parsing prose.
 */
import { inventoryIsProvablyIncomplete, type CrawlReport } from "./report.js";

export const EXIT = {
  /** The orphan question was answered. The table printed is the whole site. */
  ok: 0,
  /** Usage, registry or configuration error. Nothing was crawled. */
  usage: 1,
  /**
   * The run failed and printed no numbers, because a subset of a site is not a smaller
   * site. **Deliberately wide**: a partial crawl, an analysis that refused this crawl,
   * an unmigrated or unreachable database, a bug here. Measured 2026-08-24 —
   * `npx link-graph crawl nope` against a database with no migrations exits 2 with
   * `relation "sites" does not exist` — so a code documented as "the estate refused the
   * crawl" would have been a false statement. Telling infrastructure from analysis needs
   * a mapping of pg SQLSTATEs that nothing here has measured, and a wrong split is worse
   * than an honest union: the message says which.
   */
  failed: 2,
  /**
   * The crawl finished and the orphan question was **not** answered for the whole site.
   * Three causes, one code: no truth source, a sample (PRD §2's Undetectable, §15), or
   * an inventory that a lost source made provably short (decided 2026-08-25, PRD §15).
   * A coverage gap, never zero orphans. Non-zero even for `sampled`, which is deliberate
   * rather than a failure: deliberate or not, it is not an answer, and a caller reading
   * only this code must not record it as one.
   */
  undetectable: 3,
} as const;

/**
 * A failure whose remedy is in the invocation rather than in the site or the code: an
 * unknown command, a site that is not in the registry, a disabled site, an unusable
 * `DATABASE_URL`. Separated from every other failure because nothing was crawled and
 * nothing is wrong with the estate.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * The orphan count is an answer only when it was counted **and** counted against the
 * whole inventory. Both tests land on the same code, because a caller reading only the
 * exit status needs one question answered — "may I record this as the site's orphan
 * count?" — and the printed report says which of the two it was.
 */
export function exitCodeForReport(report: CrawlReport): number {
  if (report.metrics.orphansUnknownReason !== null) return EXIT.undetectable;
  if (inventoryIsProvablyIncomplete(report.truth.findings)) return EXIT.undetectable;
  return EXIT.ok;
}

export function exitCodeForFailure(error: unknown): number {
  return error instanceof UsageError ? EXIT.usage : EXIT.failed;
}
