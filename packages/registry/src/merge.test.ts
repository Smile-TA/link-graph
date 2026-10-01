import { describe, expect, it } from "vitest";
import type { DerivedSite } from "./derive.js";
import { mergeRegistry, mergeSite } from "./merge.js";

const derived = (over: Partial<DerivedSite>): DerivedSite => ({
  appDir: "example.com",
  prodHosts: ["example.com", "www.example.com"],
  stageHosts: ["example.staging02.imgwebhost.com"],
  deployedTag: "v1.0.0",
  ...over,
});

describe("mergeSite", () => {
  it("becomes an enabled row with canonical host + aliases + stage host by default", () => {
    const row = mergeSite(derived({}), () => undefined);
    expect(row).toEqual({
      siteId: "example.com",
      canonicalHost: "example.com",
      aliases: ["example.com", "www.example.com"],
      stageHost: "example.staging02.imgwebhost.com",
      enabled: true,
      truthSource: null,
      crawlerMode: "http",
      crawlScope: "full",
      sampleCeiling: null,
      rateLimit: 1.0,
      ignorePaths: [],
      ignoreLinkPatterns: [],
      redirectTargetHost: null,
    });
  });

  it("is null (excluded) with no prod hosts and no curation opt-in", () => {
    expect(mergeSite(derived({ prodHosts: [] }), () => undefined)).toBeNull();
  });

  it("curation excluded: true always drops the site, even with hosts", () => {
    expect(mergeSite(derived({}), () => ({ excluded: true }))).toBeNull();
  });

  it("curation can set enabled: false without dropping the row", () => {
    const row = mergeSite(derived({}), () => ({ enabled: false }));
    expect(row?.enabled).toBe(false);
  });

  it("curation crawlerMode, rateLimit, ignorePaths and ignoreLinkPatterns override the defaults", () => {
    const row = mergeSite(derived({}), () => ({
      crawlerMode: "playwright",
      rateLimit: 0.5,
      ignorePaths: ["/wp-admin/"],
      ignoreLinkPatterns: ["doubleclick.net"],
    }));
    expect(row?.crawlerMode).toBe("playwright");
    expect(row?.rateLimit).toBe(0.5);
    expect(row?.ignorePaths).toEqual(["/wp-admin/"]);
    expect(row?.ignoreLinkPatterns).toEqual(["doubleclick.net"]);
  });

  it("no stage values file means stageHost is null, not undefined or a throw", () => {
    const row = mergeSite(derived({ stageHosts: [] }), () => undefined);
    expect(row?.stageHost).toBeNull();
  });
});

describe("mergeRegistry", () => {
  it("drops excluded apps and keeps the rest, over a small mixed set", () => {
    const sites: DerivedSite[] = [
      derived({ appDir: "a.com", prodHosts: ["a.com"] }),
      derived({ appDir: "a.com-traefik-canary", prodHosts: [] }),
      derived({ appDir: "b.com", prodHosts: ["b.com"] }),
    ];
    const rows = mergeRegistry(sites, {
      "a.com-traefik-canary": { excluded: true, reason: "variant" },
    });
    expect(rows.map((r) => r.siteId)).toEqual(["a.com", "b.com"]);
  });
});
