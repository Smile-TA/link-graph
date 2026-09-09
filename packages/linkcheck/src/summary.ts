/**
 * One run's results, as the rows to write and the numbers to print.
 *
 * Pure, and the clock is a parameter (guide §4.4). The counts are the §1 surface of this
 * package: `broken` on its own is a number a reader will mistake for the site's external
 * link health, so it never travels without `checked` beside it and `checked` never
 * travels without the crawl's total (`LinkcheckResult` in check.ts).
 */
import type { ExternalUrlInput } from "@link-graph/db";
import type { LinkResult } from "./report.js";
import { externalUrlVerdict, isBrokenExternal } from "./verdict.js";

export interface LinkcheckCounts {
  /** URLs handed to the checker. */
  readonly checked: number;
  /** Answered, and alive. */
  readonly ok: number;
  /** Answered, and the resource is absent — 404 or 410 only (see verdict.ts). */
  readonly broken: number;
  /** Not answered: blocked, rate-limited, timed out, unreachable, or not checked. */
  readonly unverified: number;
  /**
   * `ok + broken`. Named separately because it is what `linkcheckVerdict` refuses on,
   * and deriving it there from two other fields would put the definition in two places.
   */
  readonly conclusive: number;
}

export function summariseResults(
  results: readonly LinkResult[],
  now: Date,
): { rows: ExternalUrlInput[]; counts: LinkcheckCounts } {
  const rows: ExternalUrlInput[] = [];
  let ok = 0;
  let broken = 0;
  let unverified = 0;

  for (const result of results) {
    const verdict = externalUrlVerdict(result.outcome);
    rows.push({
      urlNormalized: result.url,
      lastChecked: now,
      statusCode: verdict.statusCode,
      unverified: verdict.unverified,
      detail: verdict.detail,
    });
    if (verdict.unverified) unverified += 1;
    else if (isBrokenExternal(verdict)) broken += 1;
    else ok += 1;
  }

  return {
    rows,
    // Every bucket named even when empty, for the reason `countBuckets` in
    // packages/review names all three: a tally built by counting what is present prints
    // no "0 broken" line, and "0 broken" is exactly the line a reader needs.
    counts: { checked: results.length, ok, broken, unverified, conclusive: ok + broken },
  };
}
