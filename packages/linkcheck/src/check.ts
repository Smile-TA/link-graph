/**
 * The service: check one crawl's external URLs that are due, and record what came back.
 *
 * Wiring only (guide §4.1) — the TTL query is SQL in `packages/db`, the classification is
 * `verdict.ts`, the reconciliation is `report.ts`, the subprocess is `lychee.ts`. What is
 * left here is the order they run in and the two refusals.
 */
import {
  countExternalUrls,
  listExternalUrlsDue,
  upsertExternalUrls,
  type Queryable,
} from "@link-graph/db";
import { reconcile } from "./report.js";
import { summariseResults, type LinkcheckCounts } from "./summary.js";
import { linkcheckVerdict } from "./verdict.js";
import type { LycheeRunner } from "./lychee.js";

export interface LinkcheckDeps {
  readonly runner: LycheeRunner;
  /** Injected (guide §4.4): `last_checked` is what the TTL reads, so it is asserted on. */
  readonly now: () => Date;
}

export interface LinkcheckOptions {
  /**
   * How long a recorded check stays good.
   *
   * One week, because PRD §7 sizes retention at "12 crawls per site (~3 months at weekly
   * cadence)" — so a TTL shorter than the cadence would re-check every URL on every
   * crawl and throw away the sharing PRD §6.1 calls the strongest argument for
   * centralising this. It is the knob that decides how many third-party requests the
   * estate makes, so it is a parameter rather than a constant, and the number itself is
   * reasoned from the cadence rather than measured — nothing yet knows how often a
   * third-party URL actually changes state.
   */
  readonly ttlHours?: number;
}

const DEFAULT_TTL_HOURS = 24 * 7;

export interface LinkcheckResult extends LinkcheckCounts {
  /**
   * Every distinct external URL of the crawl. **Carried so that `broken` cannot be read
   * as covering the site**: "1 broken of 3 checked, 639 still fresh" and "1 broken of
   * 642" are different reports, and only the numbers can tell them apart.
   */
  readonly external: number;
  /** Of those, how many were due. Equal to `checked` on a run that completed. */
  readonly due: number;
  /** Skipped because another run — possibly another site's — checked them recently. */
  readonly fresh: number;
  /** Rows written. Equal to `checked`, or the run refused. */
  readonly recorded: number;
}

/**
 * Thrown when a run could not tell anything about any URL, carrying the counts.
 *
 * Thrown rather than returned, following `PartialCrawlError`: a caller that ignores the
 * outcome gets an unhandled rejection and a non-zero exit, where a returned
 * `{ status: 'partial' }` is a value someone can forget to read. **Nothing has been
 * written when this throws** — see `linkcheckVerdict`.
 */
export class IncompleteLinkcheckError extends Error {
  constructor(
    message: string,
    readonly result: LinkcheckResult,
  ) {
    super(message);
    this.name = "IncompleteLinkcheckError";
  }
}

export async function checkExternalUrls(
  db: Queryable,
  crawlId: number,
  deps: LinkcheckDeps,
  options: LinkcheckOptions = {},
): Promise<LinkcheckResult> {
  const now = deps.now();
  const ttlHours = options.ttlHours ?? DEFAULT_TTL_HOURS;
  const checkedBefore = new Date(now.getTime() - ttlHours * 60 * 60 * 1000);

  const external = await countExternalUrls(db, crawlId);
  const due = await listExternalUrlsDue(db, crawlId, checkedBefore);
  if (due.length === 0) {
    // Not a failure: the TTL did its job, or the crawl has no external links. The counts
    // say which, so a caller cannot print "0 broken" as though 642 had been asked.
    return {
      external,
      due: 0,
      fresh: external,
      recorded: 0,
      checked: 0,
      ok: 0,
      broken: 0,
      unverified: 0,
      conclusive: 0,
    };
  }

  const report = await deps.runner.run(due);
  const { rows, counts } = summariseResults(reconcile(due, report), now);
  const verdict = linkcheckVerdict(counts);
  const result: LinkcheckResult = {
    ...counts,
    external,
    due: due.length,
    fresh: external - due.length,
    recorded: 0,
  };
  if (verdict.status === "partial") {
    throw new IncompleteLinkcheckError(
      `external link check of crawl ${String(crawlId)} is incomplete: ${verdict.stoppedBecause ?? ""}`,
      result,
    );
  }

  const recorded = await upsertExternalUrls(db, rows);
  if (recorded !== rows.length) {
    // A short write means some of what we spent third-party requests learning is not in
    // the table, and those URLs would read as never checked while this run reported
    // having checked them.
    throw new Error(
      `recorded ${String(recorded)} of ${String(rows.length)} external URL checks for ` +
        `crawl ${String(crawlId)}`,
    );
  }
  return { ...result, recorded };
}
