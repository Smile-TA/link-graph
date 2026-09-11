/**
 * `link-graph registry sync` and `link-graph registry report` (step 9).
 *
 *     git clone deployment-configurations → derive → curation merge → upsertSite
 *          → probeLiveness → registry_health → (report) coverage-drift table
 *
 * `sync` is the one command in this project that reaches the network for something
 * other than the site under test — a real clone and a real probe of every site it
 * derives — so its `deps` seam exists for the same reason `crawl`'s does: the
 * integration tier has to run it whole against a fake clone and a fake prober, never
 * against the live estate on every test run.
 */
import {
  syncRegistry,
  registryDriftReport,
  formatDriftReport,
  createGitCloneDeps,
  createProbeDeps,
} from "@link-graph/registry";
import type { SyncDeps } from "@link-graph/registry";
import type { Pool } from "pg";

export interface RegistrySyncOutcome {
  readonly sha: string;
  readonly derivedCount: number;
  readonly mergedCount: number;
  readonly siteCount: number;
}

export async function runRegistrySyncCommand(
  pool: Pool,
  deps: Partial<SyncDeps> = {},
): Promise<RegistrySyncOutcome> {
  const result = await syncRegistry(pool, {
    clone: deps.clone ?? createGitCloneDeps(),
    probe: deps.probe ?? createProbeDeps(),
    ...(deps.derive !== undefined ? { derive: deps.derive } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  return {
    sha: result.sha,
    derivedCount: result.derivedCount,
    mergedCount: result.mergedCount,
    siteCount: result.sites.length,
  };
}

export function formatSyncOutcome(outcome: RegistrySyncOutcome): string {
  return (
    `synced deployment-configurations @ ${outcome.sha}\n` +
    `${outcome.derivedCount} app directories derived, ${outcome.mergedCount} became ` +
    `sites rows (${outcome.derivedCount - outcome.mergedCount} excluded by curation), ` +
    `${outcome.siteCount} probed`
  );
}

export async function runRegistryReportCommand(pool: Pool): Promise<string> {
  const drift = await registryDriftReport(pool);
  return formatDriftReport(drift);
}
