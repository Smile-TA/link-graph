/**
 * Merge: derived registry (from the clone) + curation overlay → final `sites` rows
 * (PRD §3, step 9 item 3). Pure — no filesystem, no network, no database — so the
 * decision "which of 195 app directories become a `sites` row, and with what settings"
 * is unit-tested directly.
 */
import type { SiteInput } from "@link-graph/db";
import type { Curation } from "./curation.js";
import type { DerivedSite } from "./derive.js";

/**
 * `null` means "excluded" — the curation overlay said `excluded: true`, or the app has
 * no prod hostname and the overlay did not opt it in anyway. Filtering these out here,
 * rather than writing them as `enabled: false` rows, keeps 165-ish content sites in
 * `sites` instead of 195 app directories with 30-odd rows nothing can ever crawl (no
 * `canonicalHost` to crawl them with).
 */
export function mergeSite(
  derived: DerivedSite,
  curation: CurationEntryFor,
): SiteInput | null {
  const overlay = curation(derived.appDir) ?? {};
  if (overlay.excluded === true) return null;
  if (derived.prodHosts.length === 0 && overlay.enabled !== true) return null;

  const [canonicalHost, ...aliases] = derived.prodHosts;
  // The guard above guarantees at least one host once `overlay.enabled` forces it
  // through; an app opted in with zero prod hosts and no overlay-supplied host has
  // nothing to crawl, so it is still excluded rather than written with a null host.
  if (canonicalHost === undefined) return null;

  return {
    siteId: derived.appDir,
    canonicalHost,
    aliases: [canonicalHost, ...aliases],
    stageHost: derived.stageHosts[0] ?? null,
    enabled: overlay.enabled ?? true,
    truthSource: null,
    crawlerMode: overlay.crawlerMode ?? "http",
    crawlScope: "full",
    sampleCeiling: null,
    rateLimit: overlay.rateLimit ?? 1.0,
    ignorePaths: overlay.ignorePaths ?? [],
  };
}

type CurationEntryFor = (appDir: string) => Curation[string] | undefined;

/** Every derived site, merged, with the excluded ones dropped. */
export function mergeRegistry(
  derived: readonly DerivedSite[],
  curation: Curation,
): SiteInput[] {
  const lookup: CurationEntryFor = (appDir) => curation[appDir];
  const merged: SiteInput[] = [];
  for (const site of derived) {
    const row = mergeSite(site, lookup);
    if (row !== null) merged.push(row);
  }
  return merged;
}
