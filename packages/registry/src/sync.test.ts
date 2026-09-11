/**
 * `syncRegistry` against fakes for every I/O seam — no clone, no probe, no real
 * database. The one thing this file exists to pin: `mergeSite` has no database access,
 * so it always produces `truthSource: null`; a sync that upserts that value verbatim
 * would silently erase a `truthSource` step 5/6 already resolved on every re-run.
 */
import { describe, expect, it } from "vitest";
import type { Queryable } from "@link-graph/db";
import type { SiteRow } from "@link-graph/db";
import type { QueryResult, QueryResultRow } from "pg";
import { syncRegistry } from "./sync.js";
import type { DerivedSite } from "./derive.js";

const DERIVED: DerivedSite = {
  appDir: "a-403bplan.net",
  prodHosts: ["403bplan.net"],
  stageHosts: [],
  deployedTag: "v1.0.0",
};

function fakeDb(existing: SiteRow | null): { db: Queryable; upserted: unknown[] } {
  const upserted: unknown[] = [];
  const db: Queryable = {
    query<R extends QueryResultRow>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      if (text.includes("SELECT") && text.includes("site_id = $1")) {
        return Promise.resolve({
          rows: existing ? [existing as unknown as R] : [],
        } as QueryResult<R>);
      }
      if (text.includes("INSERT INTO sites")) {
        upserted.push(params);
        const row: SiteRow = {
          id: existing?.id ?? 1,
          siteId: "a-403bplan.net",
          canonicalHost: "403bplan.net",
          aliases: ["403bplan.net"],
          stageHost: null,
          enabled: true,
          truthSource: params?.[5] as SiteRow["truthSource"],
          crawlerMode: "http",
          crawlScope: "full",
          sampleCeiling: null,
          rateLimit: 1.0,
          ignorePaths: [],
        };
        return Promise.resolve({ rows: [row as unknown as R] } as QueryResult<R>);
      }
      if (text.includes("INSERT INTO registry_health")) {
        return Promise.resolve({ rows: [] } as unknown as QueryResult<R>);
      }
      throw new Error(`fakeDb: unexpected query ${text}`);
    },
  };
  return { db, upserted };
}

const deps = {
  clone: {
    clone: () => Promise.resolve({ dir: "/fake", sha: "a".repeat(40) }),
    cleanup: () => Promise.resolve(),
  },
  derive: {
    listAppDirs: () => Promise.resolve([DERIVED.appDir]),
    readValuesFile: (path: string) =>
      Promise.resolve(
        path.includes("prod")
          ? "ingress:\n  entries:\n    - hosts:\n        - hostname: 403bplan.net\nimage:\n  tag: v1.0.0\n"
          : null,
      ),
  },
  probe: {
    resolveDns: () => Promise.resolve({ ok: false }),
    fetchUrl: () => Promise.resolve({ ok: false, status: null, headers: {}, body: null }),
  },
};

describe("syncRegistry: truthSource preservation", () => {
  it("leaves an already-resolved truthSource alone on a re-sync", async () => {
    const existing: SiteRow = {
      id: 42,
      siteId: "a-403bplan.net",
      canonicalHost: "403bplan.net",
      aliases: ["403bplan.net"],
      stageHost: null,
      enabled: true,
      truthSource: "sitemap",
      crawlerMode: "http",
      crawlScope: "full",
      sampleCeiling: null,
      rateLimit: 1.0,
      ignorePaths: [],
    };
    const { db } = fakeDb(existing);

    const result = await syncRegistry(db, deps);

    expect(result.sites[0]?.truthSource).toBe("sitemap");
  });

  it("writes null for a genuinely new site, not a fabricated value", async () => {
    const { db } = fakeDb(null);

    const result = await syncRegistry(db, deps);

    expect(result.sites[0]?.truthSource).toBeNull();
  });
});
