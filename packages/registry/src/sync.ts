/**
 * `syncRegistry`: the whole step-9 pipeline the CLI's `registry sync` calls — clone,
 * derive, merge with curation, upsert, probe, write `registry_health`. Every I/O seam
 * (clone, filesystem, database, probe) is a parameter, so this file is orchestration
 * only and every decision it makes lives in `derive.ts`, `merge.ts`, `liveness.ts` —
 * exactly `run.ts`'s pattern for `crawl`.
 */
import {
  findSiteBySlug,
  insertRegistryHealth,
  upsertSite,
  type Queryable,
  type SiteRow,
} from "@link-graph/db";
import { withClone, type CloneDeps } from "./clone.js";
import { loadCuration } from "./curation.js";
import { createFsDeriveDeps, deriveSites, type DeriveDeps } from "./derive.js";
import { probeLiveness, type LivenessDeps } from "./liveness.js";
import { mergeRegistry } from "./merge.js";

export interface SyncDeps {
  readonly clone: CloneDeps;
  readonly derive: DeriveDeps;
  readonly probe: LivenessDeps;
  readonly now: () => Date;
}

export interface SyncResult {
  readonly sha: string;
  readonly derivedCount: number;
  readonly mergedCount: number;
  readonly sites: readonly SiteRow[];
}

export async function syncRegistry(
  db: Queryable,
  deps: Pick<SyncDeps, "clone" | "probe"> & Partial<SyncDeps>,
): Promise<SyncResult> {
  const derive = deps.derive ?? createFsDeriveDeps();
  const now = deps.now ?? (() => new Date());
  const curation = await loadCuration();

  return withClone(deps.clone, async (repo) => {
    const derived = await deriveSites(derive, repo.dir);
    const merged = mergeRegistry(derived, curation);

    const sites: SiteRow[] = [];
    for (const input of merged) {
      // `mergeSite` has no database access, so it cannot know a site's resolved
      // `truthSource` (step 5/6's crawl output). Re-reading the existing row before
      // upserting keeps a sync from silently resetting it to null on every re-run —
      // sync's job is registry facts, not truth-source resolution.
      const existing = await findSiteBySlug(db, input.siteId);
      const row = await upsertSite(db, {
        ...input,
        truthSource: existing?.truthSource ?? input.truthSource,
      });
      sites.push(row);
      const probe = await probeLiveness(row.canonicalHost, deps.probe, now);
      await insertRegistryHealth(db, {
        siteId: row.id,
        checkedAt: probe.checkedAt,
        dnsOk: probe.dnsOk,
        serves: probe.serves,
        platformSig: probe.platformSig,
        versionTxt: probe.versionTxt,
      });
    }

    return {
      sha: repo.sha,
      derivedCount: derived.length,
      mergedCount: merged.length,
      sites,
    };
  });
}
