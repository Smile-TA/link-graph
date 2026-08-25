/**
 * Complete or partial — the most consequential rule in this package, as a pure function.
 *
 * It is here rather than inside the crawl loop because engineering guide §1 is exactly
 * this decision: a crawl that ended early must never be reported as a finished one, and
 * a rule that can only be exercised with Postgres and a fixture server running is a rule
 * whose edge cases nobody checks. This needs neither.
 */
import type { SiteRow } from "@link-graph/db";
import { atSampleCeiling } from "./sample.js";

export interface CrawlProgress {
  /** Why the loop stopped early, or `null` when it ran out of work. */
  readonly stoppedBecause: string | null;
  /** Frontier entries with no page row. */
  readonly pending: number;
  /** Page rows this crawl has written. */
  readonly pages: number;
}

export interface CrawlVerdict {
  readonly status: "complete" | "partial";
  /** The reason, `null` exactly when the status is `complete`. */
  readonly stoppedBecause: string | null;
}

/**
 * A crawl is complete when it owes no page rows — or when a sampled crawl reached the
 * ceiling it was told to stop at, which is policy rather than shortfall (PRD §15).
 *
 * Everything else is partial, including the two cases the loop has no name for:
 *
 * - an unfetched frontier with no recorded reason. That is a bug in the loop, and
 *   reporting it as a finished crawl would hide it behind a plausible page count.
 * - **zero pages.** A crawl that fetched nothing is the pw-template failure the
 *   engineering guide opens with, and it is reachable here: a crawl whose frontier
 *   seeding died leaves a `running` row that a resume would otherwise find empty and
 *   declare complete.
 */
export function crawlVerdict(site: SiteRow, progress: CrawlProgress): CrawlVerdict {
  const { stoppedBecause, pending, pages } = progress;
  if (stoppedBecause !== null) return { status: "partial", stoppedBecause };
  if (pages === 0) {
    return {
      status: "partial",
      stoppedBecause:
        `the crawl wrote no pages at all, with ${pending} URL(s) queued. A crawl that ` +
        `fetched nothing must never be reported as a finished one: every count from ` +
        `it, "0 orphans" loudest of all, would read as good news`,
    };
  }
  if (pending === 0 || atSampleCeiling(site, pages)) {
    return { status: "complete", stoppedBecause: null };
  }
  return {
    status: "partial",
    stoppedBecause:
      `the crawl loop ended with ${pending} URL(s) still queued and no reason ` +
      `recorded, which is a bug in the loop rather than a property of the site`,
  };
}
