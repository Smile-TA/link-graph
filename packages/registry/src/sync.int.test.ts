/**
 * The step-9 pipeline against the real network and real Postgres, in two halves:
 *
 * 1. Clone + derive + curation merge against the real `deployment-configurations` —
 *    this is cheap (one clone, no per-site network calls) and is run over the whole
 *    derived registry, because deriving is pure parsing, not a live check.
 * 2. Liveness probe + `sites`/`registry_health` writes against **three** real hosts
 *    drawn from that clone — deliberately small, per this project's convention (step
 *    6: fixture servers or a small deliberate live check, never a full estate sweep
 *    in a test). `syncRegistry` itself probes every merged site when it runs for
 *    real; a unit test elsewhere (`sync.test.ts`, if this file needed one) would fake
 *    the probe, but this integration test's job is to prove the real probe and the
 *    real database write both work, not to reproduce the whole estate's liveness.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTempDatabase,
  findSiteBySlug,
  insertRegistryHealth,
  listRegistryHealth,
  runMigrations,
  upsertSite,
} from "@link-graph/db";
import type { TempDatabase } from "@link-graph/db";
import { createGitCloneDeps, withClone } from "./clone.js";
import { createFsDeriveDeps, deriveSites } from "./derive.js";
import { loadCuration } from "./curation.js";
import { mergeRegistry } from "./merge.js";
import { probeLiveness } from "./liveness.js";
import { createProbeDeps } from "./probe-adapter.js";

let db: TempDatabase;
beforeAll(async () => {
  db = await createTempDatabase("registry");
  await runMigrations(db.pool);
});
afterAll(async () => {
  await db.drop();
});

describe("the registry pipeline against the live clone and real Postgres", () => {
  it("derives and merges the whole real estate, then probes three real hosts for real", async () => {
    const cloneDeps = createGitCloneDeps();
    const { sha, merged } = await withClone(cloneDeps, async (repo) => {
      const derived = await deriveSites(createFsDeriveDeps(), repo.dir);
      const curation = await loadCuration();
      return { sha: repo.sha, merged: mergeRegistry(derived, curation) };
    });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // Measured 2026-09-11: 199 app directories, 36 excluded by src/curation.json,
    // 163 became sites rows. Asserted as a range so publishing a new app in the real
    // repo is not a test failure.
    expect(merged.length).toBeGreaterThan(100);
    expect(merged.length).toBeLessThan(199);

    // Three real hosts from the real merge output — none of them variant/utility
    // directories, so all three are expected to actually be served.
    const sample = merged.filter((s) =>
      ["agentcore.com", "a-403bplan.net", "advisorsib.com"].includes(s.siteId),
    );
    expect(sample.length).toBeGreaterThan(0);

    const probeDeps = createProbeDeps();
    for (const input of sample) {
      const row = await upsertSite(db.pool, input);
      const probe = await probeLiveness(row.canonicalHost, probeDeps);
      await insertRegistryHealth(db.pool, {
        siteId: row.id,
        checkedAt: probe.checkedAt,
        dnsOk: probe.dnsOk,
        serves: probe.serves,
        platformSig: probe.platformSig,
        versionTxt: probe.versionTxt,
      });
      // Reported, not asserted strictly true/false: these are real hosts and the
      // point of this test is that the probe runs against them and produces a
      // result shape `registry_health` can store, not that every one is currently
      // up (PRD §3.1 documents dead-but-registered hosts as an expected outcome).
      console.log(
        `probed ${row.canonicalHost}: dnsOk=${probe.dnsOk} serves=${probe.serves} ` +
          `platformSig=${probe.platformSig} versionTxt=${probe.versionTxt === null ? "null" : JSON.stringify(probe.versionTxt).slice(0, 40)}`,
      );
      expect(typeof probe.dnsOk).toBe("boolean");
      // dnsOk false implies serves/platformSig false and versionTxt null — the
      // liveness.test.ts unit tests pin this; here it is re-checked on live data.
      if (!probe.dnsOk) {
        expect(probe.serves).toBe(false);
        expect(probe.platformSig).toBe(false);
        expect(probe.versionTxt).toBeNull();
      }
    }

    // At least one of the three actually wrote a registry_health row and can be
    // read back through the real repo functions.
    const stored = await findSiteBySlug(db.pool, sample[0]!.siteId);
    expect(stored).not.toBeNull();
    const health = await listRegistryHealth(db.pool, stored!.id);
    expect(health.length).toBe(1);
  }, 60_000);
});
