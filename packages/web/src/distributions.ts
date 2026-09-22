/**
 * Pure histogram builders for PRD §9 item 4 — depth, status codes, inbound link
 * counts. Bucketing lives here rather than in the chart component so it is testable
 * with no React/TanStack Charts in the loop.
 */
import type { PageAnalysisFact } from "@link-graph/db";

export interface Bucket {
  readonly label: string;
  readonly count: number;
}

/** One bar per depth, `null` (never computed — no complete crawl reached it) last. */
export function depthDistribution(pages: readonly PageAnalysisFact[]): Bucket[] {
  const counts = new Map<number, number>();
  let unknown = 0;
  for (const page of pages) {
    if (page.depth === null) {
      unknown += 1;
      continue;
    }
    counts.set(page.depth, (counts.get(page.depth) ?? 0) + 1);
  }
  const buckets = [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([depth, count]) => ({ label: String(depth), count }));
  if (unknown > 0) buckets.push({ label: "unknown", count: unknown });
  return buckets;
}

/** One bar per status code, `null` (never fetched) last. Sorted ascending by code. */
export function statusCodeDistribution(pages: readonly PageAnalysisFact[]): Bucket[] {
  const counts = new Map<number, number>();
  let neverFetched = 0;
  for (const page of pages) {
    if (page.statusCode === null) {
      neverFetched += 1;
      continue;
    }
    counts.set(page.statusCode, (counts.get(page.statusCode) ?? 0) + 1);
  }
  const buckets = [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([status, count]) => ({ label: String(status), count }));
  if (neverFetched > 0) buckets.push({ label: "never fetched", count: neverFetched });
  return buckets;
}

/**
 * Inbound internal edge counts, binned rather than one bar per integer: a real crawl
 * has boilerplate-linked pages with hundreds of inbound edges, and one bar each would
 * draw a chart nobody can read (the same reason step 12's treemap caps depth).
 */
const INBOUND_BINS: readonly { readonly max: number; readonly label: string }[] = [
  { max: 0, label: "0" },
  { max: 1, label: "1" },
  { max: 3, label: "2–3" },
  { max: 7, label: "4–7" },
  { max: 15, label: "8–15" },
  { max: Infinity, label: "16+" },
];

export function inboundLinkDistribution(pages: readonly PageAnalysisFact[]): Bucket[] {
  const counts = new Map(INBOUND_BINS.map((bin) => [bin.label, 0]));
  for (const page of pages) {
    // The last bin's max is Infinity, so this always matches.
    const bin = INBOUND_BINS.find((candidate) => page.inboundTotal <= candidate.max)!;
    counts.set(bin.label, (counts.get(bin.label) ?? 0) + 1);
  }
  return INBOUND_BINS.map((bin) => ({ label: bin.label, count: counts.get(bin.label)! }));
}
