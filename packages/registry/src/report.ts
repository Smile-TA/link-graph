/**
 * `registryDriftReport`: reads every site and the newest `registry_health` row per
 * site, and hands them to the pure classifier in `drift.ts`. The database read is here
 * so `classifyDrift` itself stays free of `pg`.
 */
import { listLatestRegistryHealth, listSites, type Queryable } from "@link-graph/db";
import { classifyDrift, type CoverageDrift, type DriftProbe } from "./drift.js";

export async function registryDriftReport(db: Queryable): Promise<CoverageDrift> {
  const sites = await listSites(db);
  const idToSlug = new Map(sites.map((s) => [s.id, s.siteId]));

  // One query for the newest probe per site (`DISTINCT ON`), not one per site — the
  // registry has 163+ rows and this report used to make a round trip for each.
  const latest = new Map<string, DriftProbe>();
  for (const probe of await listLatestRegistryHealth(db)) {
    const slug = idToSlug.get(probe.siteId);
    if (slug === undefined) continue;
    latest.set(slug, {
      dnsOk: probe.dnsOk,
      serves: probe.serves,
      platformSig: probe.platformSig,
    });
  }

  return classifyDrift(
    sites.map((s) => ({
      siteId: s.siteId,
      canonicalHost: s.canonicalHost,
      enabled: s.enabled,
    })),
    (siteId) => latest.get(siteId) ?? null,
  );
}

export function formatDriftReport(drift: CoverageDrift): string {
  const lines: string[] = [];
  lines.push(
    `Deployed but unmonitored (${drift.deployedButUnmonitored.length}):`,
    ...drift.deployedButUnmonitored.map((s) => `  ${s.siteId}  ${s.canonicalHost}`),
    "",
    `Configured but dead (${drift.configuredButDead.length}):`,
    ...drift.configuredButDead.map((s) => `  ${s.siteId}  ${s.canonicalHost}`),
  );
  return lines.join("\n");
}
