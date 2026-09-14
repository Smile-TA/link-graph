/**
 * What changed between two consecutive complete crawls of one site (PRD §7, step 13).
 *
 * Pure set difference over the subjects `packages/review` already defines findings by
 * (`urlNormalized`) — no second notion of identity gets invented here. `null` for
 * `previous` means this is the site's first crawl, and there is nothing to diff against.
 */
export type DiffKind =
  | "orphan_appeared"
  | "orphan_resolved"
  | "broken_appeared"
  | "broken_resolved";

export interface CrawlDiff {
  readonly kind: DiffKind;
  readonly url: string;
  /**
   * The release the change happened under, when both crawls carry a `deployed_tag`
   * (PRD §8: "diffs can still say these orphans appeared between v1.6.8 and v1.7.0").
   * `null` when either crawl has none — most of the estate does not attribute a tag —
   * rather than printing "unknown → unknown" as though it were information.
   */
  readonly detail: string | null;
}

export interface DiffCrawlsInput {
  readonly previousOrphans: readonly string[];
  readonly currentOrphans: readonly string[];
  readonly previousBroken: readonly string[];
  readonly currentBroken: readonly string[];
  readonly previousTag: string | null;
  readonly currentTag: string | null;
}

function setDiff(
  before: readonly string[],
  after: readonly string[],
  appeared: DiffKind,
  resolved: DiffKind,
  detail: string | null,
): CrawlDiff[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const diffs: CrawlDiff[] = [];
  for (const url of after) {
    if (!beforeSet.has(url)) diffs.push({ kind: appeared, url, detail });
  }
  for (const url of before) {
    if (!afterSet.has(url)) diffs.push({ kind: resolved, url, detail });
  }
  return diffs;
}

/** `diffCrawls(null, current)` is always `[]` — a first crawl has nothing to compare to. */
export function diffCrawls(input: DiffCrawlsInput | null): CrawlDiff[] {
  if (input === null) return [];
  const detail =
    input.previousTag !== null && input.currentTag !== null
      ? `${input.previousTag} → ${input.currentTag}`
      : null;
  return [
    ...setDiff(
      input.previousOrphans,
      input.currentOrphans,
      "orphan_appeared",
      "orphan_resolved",
      detail,
    ),
    ...setDiff(
      input.previousBroken,
      input.currentBroken,
      "broken_appeared",
      "broken_resolved",
      detail,
    ),
  ];
}
