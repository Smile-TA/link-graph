/**
 * `registryDriftReport` against real Postgres — pins the `DISTINCT ON` rewrite (which
 * replaced one `listRegistryHealth` call per site) actually returns the newest probe
 * per site and maps the surrogate id back to the right registry slug.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTempDatabase,
  insertRegistryHealth,
  runMigrations,
  upsertSite,
  type SiteInput,
  type TempDatabase,
} from "@link-graph/db";
import { registryDriftReport } from "./report.js";

let db: TempDatabase;
beforeAll(async () => {
  db = await createTempDatabase("registry_report");
  await runMigrations(db.pool);
});
afterAll(async () => {
  await db.drop();
});

const site = (siteId: string, enabled: boolean): SiteInput => ({
  siteId,
  canonicalHost: `${siteId}.example`,
  aliases: [`${siteId}.example`],
  stageHost: null,
  enabled,
  truthSource: null,
  crawlerMode: "http",
  crawlScope: "full",
  sampleCeiling: null,
  rateLimit: 1.0,
  ignorePaths: [],
});

describe("registryDriftReport", () => {
  it("uses each site's newest probe, not an older one, across more than one site", async () => {
    const dead = await upsertSite(db.pool, site("dead-site", true));
    const healthy = await upsertSite(db.pool, site("healthy-site", true));

    // An older "live" probe followed by a newer "dead" one — the report must reflect
    // the newer row, proving `ORDER BY site_id, checked_at DESC` picks the latest.
    await insertRegistryHealth(db.pool, {
      siteId: dead.id,
      checkedAt: new Date("2026-01-01T00:00:00Z"),
      dnsOk: true,
      serves: true,
      platformSig: true,
      versionTxt: "v1",
    });
    await insertRegistryHealth(db.pool, {
      siteId: dead.id,
      checkedAt: new Date("2026-01-02T00:00:00Z"),
      dnsOk: false,
      serves: false,
      platformSig: false,
      versionTxt: null,
    });
    await insertRegistryHealth(db.pool, {
      siteId: healthy.id,
      checkedAt: new Date("2026-01-01T00:00:00Z"),
      dnsOk: true,
      serves: true,
      platformSig: true,
      versionTxt: "v1",
    });

    const drift = await registryDriftReport(db.pool);

    expect(drift.configuredButDead.map((s) => s.siteId)).toContain("dead-site");
    expect(drift.configuredButDead.map((s) => s.siteId)).not.toContain("healthy-site");
    expect(drift.deployedButUnmonitored.map((s) => s.siteId)).not.toContain("dead-site");
  });
});
