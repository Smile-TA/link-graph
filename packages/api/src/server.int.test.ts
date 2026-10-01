/**
 * The three routes end to end, over a real Postgres seeded with `loadFixture` — no
 * crawler in the test path, per the implementation plan's test note for this step.
 *
 * The site is 403bplan.net's real captures, the same bytes `analyse.int.test.ts` and
 * `review-command.int.test.ts` use, so the 4 orphans asserted here are not invented.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { analyse } from "@link-graph/analyse";
import { build403bplanCrawl } from "@link-graph/analyse";
import {
  createTempDatabase,
  loadFixture,
  parseCrawlFixture,
  runMigrations,
  upsertSite,
  type TempDatabase,
} from "@link-graph/db";
import { createServer } from "./server.js";

let db: TempDatabase;

beforeAll(async () => {
  db = await createTempDatabase("api");
  await runMigrations(db.pool);
});

afterAll(async () => {
  await db.drop();
});

let server: Server | undefined;

afterEach(async () => {
  if (server === undefined) return;
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

function listen(): Promise<string> {
  server = createServer(db.pool);
  return new Promise((resolve) => {
    server?.listen(0, () => {
      const { port } = server?.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function seedSite(slug: string): Promise<void> {
  const built = build403bplanCrawl();
  const json = { ...built, site: { ...built.site, siteId: slug } };
  const { crawlId } = await loadFixture(db.pool, parseCrawlFixture(json));
  await analyse(db.pool, crawlId);
}

describe("GET /sites", () => {
  it("lists the registry", async () => {
    const slug = "api-list-1";
    await seedSite(slug);
    const base = await listen();

    const res = await fetch(`${base}/sites`);
    expect(res.status).toBe(200);
    const sites = (await res.json()) as { siteId: string }[];
    expect(sites.map((site) => site.siteId)).toContain(slug);
  });
});

describe("GET /sites/:slug", () => {
  it("returns the registry row", async () => {
    const slug = "api-site-1";
    await seedSite(slug);
    const base = await listen();

    const res = await fetch(`${base}/sites/${slug}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ siteId: slug, canonicalHost: "403bplan.net" });
  });

  it("404s an unknown site", async () => {
    const base = await listen();
    const res = await fetch(`${base}/sites/does-not-exist`);
    expect(res.status).toBe(404);
  });
});

describe("GET /sites/:slug/report", () => {
  it("is the same report link-graph report prints, as JSON", async () => {
    const slug = "api-report-1";
    await seedSite(slug);
    const base = await listen();

    const res = await fetch(`${base}/sites/${slug}/report`);
    expect(res.status).toBe(200);
    const report = (await res.json()) as { metrics: { orphans: number } };
    expect(report.metrics.orphans).toBe(4);
  });

  it("404s an unregistered site", async () => {
    const base = await listen();
    const res = await fetch(`${base}/sites/does-not-exist/report`);
    expect(res.status).toBe(404);
  });

  it("409s a registered site with no complete crawl yet", async () => {
    const slug = "api-report-uncrawled";
    await upsertSite(db.pool, {
      siteId: slug,
      canonicalHost: "uncrawled.example",
      aliases: [],
      stageHost: null,
      enabled: true,
      truthSource: null,
      crawlerMode: "http",
      crawlScope: "full",
      sampleCeiling: null,
      rateLimit: 1,
      ignorePaths: [],
      ignoreLinkPatterns: [],
      redirectTargetHost: null,
    });
    const base = await listen();

    const res = await fetch(`${base}/sites/${slug}/report`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no complete crawl");
  });
});

describe("malformed paths", () => {
  it("404s a doubled slash rather than silently rerouting", async () => {
    const base = await listen();
    const res = await fetch(`${base}/sites//report`);
    expect(res.status).toBe(404);
  });
});
