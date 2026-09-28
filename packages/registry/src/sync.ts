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
      // Probed by canonical host before the upsert, not after, because a cross-host
      // redirect (askintegrity.com → integrity.com, docs/notes.md item 1) has to
      // override `enabled` on the very row being written — probing the already-written
      // row would mean either a second write or a stale `enabled` for one sync cycle.
      const probe = await probeLiveness(input.canonicalHost, deps.probe, now);
      const row = await upsertSite(db, {
        ...input,
        truthSource: existing?.truthSource ?? input.truthSource,
        // A redirect alias is never independently crawlable, regardless of what
        // curation says — overrides `input.enabled` rather than merging with it. Not
        // sticky: re-derived every sync, so a redirect that disappears flips this back
        // to whatever curation/derive would otherwise say (PRD-adjacent decision in
        // docs/05-improvement-plan.md, "re-probed on every sync").
        enabled: probe.redirectsToHost !== null ? false : input.enabled,
        redirectTargetHost: probe.redirectsToHost,
      });
      sites.push(row);
      await insertRegistryHealth(db, {
        siteId: row.id,
        checkedAt: probe.checkedAt,
        dnsOk: probe.dnsOk,
        serves: probe.serves,
        platformSig: probe.platformSig,
        versionTxt: probe.versionTxt,
        redirectsToHost: probe.redirectsToHost,
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
