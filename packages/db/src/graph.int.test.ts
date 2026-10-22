/**
 * The dashboard's graph queries (`repo/graph.ts`) against a real schema: page positions,
 * the lossless edge grouping, the neighbourhood scope, external evidence, and — the one
 * that matters — that "broken" is exactly `crawl_metrics.broken`'s predicate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import { listLatestCrawlsPerSite } from "./repo/crawls.js";
import {
  countLinksPerCrawl,
  listGraphBrokenEdges,
  listGraphConnections,
  listGraphExternalLinks,
  listGraphPages,
} from "./repo/graph.js";
import { insertLinks, type LinkInput } from "./repo/links.js";
import { listPages, type PageInput } from "./repo/pages.js";
import { upsertSite } from "./repo/sites.js";
import { insertCompleteCrawl } from "./testing/crawls.js";
import { createTempDatabase, type TempDatabase } from "./testing/temp-database.js";

let db: TempDatabase;
let siteId: number;
let crawlId: number;
const host = "https://graph.example";

function page(path: string, statusCode: number | null = 200): PageInput {
  return {
    urlNormalized: `${host}${path}`,
    path,
    postType: null,
    statusCode,
    depth: 1,
    inTruthSource: true,
    indexable: true,
    canonicalTo: null,
    redirectTo: null,
    class: "linked",
  };
}

beforeAll(async () => {
  db = await createTempDatabase("graph");
  await runMigrations(db.pool);
  const site = await upsertSite(db.pool, {
    siteId: "graph-example",
    canonicalHost: "graph.example",
    aliases: ["graph.example"],
    stageHost: null,
    enabled: true,
    truthSource: "sitemap",
    crawlerMode: "http",
    crawlScope: "full",
    sampleCeiling: null,
    rateLimit: 1,
    ignorePaths: [],
    ignoreLinkPatterns: [],
    redirectTargetHost: null,
  });
  siteId = site.id;
  // Paths chosen so `path` order differs from insert order: /b/ is inserted first.
  const crawl = await insertCompleteCrawl(db.pool, siteId, new Date("2026-10-01T00:00:00Z"), {
    pages: [page("/b/"), page("/a/"), page("/c/"), page("/gone/", 404), page("/never/", null)],
  });
  crawlId = crawl.id;
  const ids = new Map((await listPages(db.pool, crawlId)).map((row) => [row.path, row.id]));
  const id = (path: string) => ids.get(path) as number;
  // `(crawl, from page, dom_index)` is unique: each link a page carries has its own position.
  const nextIndex = new Map<string, number>();
  const edge = (
    from: string,
    to: string | null,
    over: Partial<LinkInput> = {},
  ): LinkInput => ({
    fromPageId: id(from),
    toUrlNormalized: `${host}${to ?? "/unresolved/"}`,
    toPageId: to === null ? null : id(to),
    anchor: "",
    rel: null,
    isExternal: false,
    isBoilerplate: false,
    container: "main",
    domIndex: (nextIndex.set(from, (nextIndex.get(from) ?? -1) + 1), nextIndex.get(from) ?? 0),
    ...over,
  });
  await insertLinks(db.pool, crawlId, [
    edge("/a/", "/b/", { anchor: "to b" }),
    edge("/a/", "/b/", { anchor: "to b" }), // a repeat: groups with the one above
    edge("/b/", "/c/"),
    edge("/c/", "/a/", { container: "footer", isBoilerplate: true }),
    edge("/a/", "/a/"), // self-link: never an edge, never an inbound count
    edge("/a/", "/gone/", { anchor: "dead" }), // broken: target fetched, served 404
    edge("/b/", "/never/"), // target never fetched: unknown, not broken
    edge("/a/", null), // unresolved: no such page
    edge("/a/", null, {
      isExternal: true,
      toUrlNormalized: "https://elsewhere.example/x",
      anchor: "ext",
    }),
  ]);
});
afterAll(async () => {
  await db.drop();
});

describe("listGraphPages", () => {
  it("orders by path then id and counts distinct internal neighbours, self-links excluded", async () => {
    const pages = await listGraphPages(db.pool, crawlId);
    expect(pages.map((row) => row.path)).toEqual(["/a/", "/b/", "/c/", "/gone/", "/never/"]);
    const a = pages[0];
    // /a/ is linked from /c/ only (its self-link does not count) and links to /b/, /gone/.
    expect(a).toMatchObject({ inboundCount: 1, outboundCount: 2, pageClass: "linked" });
    expect(pages[1]).toMatchObject({ inboundCount: 1, outboundCount: 2 }); // /b/: from /a/; to /c/, /never/
  });
});

describe("listGraphConnections", () => {
  it("groups repeated links, drops self-links, and addresses pages by position", async () => {
    const edges = await listGraphConnections(db.pool, crawlId);
    // Positions follow listGraphPages: /a/=0 /b/=1 /c/=2 /gone/=3 /never/=4.
    expect(edges).toContainEqual({
      from: 0,
      to: 1,
      anchor: "to b",
      container: "main",
      isBoilerplate: false,
      count: 2,
    });
    expect(edges.some((row) => row.from === row.to)).toBe(false);
    expect(edges).toContainEqual(expect.objectContaining({ from: 2, to: 0, container: "footer", isBoilerplate: true }));
    // Unresolved and external links are not graph edges.
    expect(edges.every((row) => row.to <= 4)).toBe(true);
  });

  it("scopes to a neighbourhood: one hop is the focus page's direct links, either way", async () => {
    const oneHop = await listGraphConnections(db.pool, crawlId, { path: "/gone/", hops: 1 });
    expect(oneHop).toEqual([expect.objectContaining({ from: 0, to: 3, anchor: "dead" })]);
    const twoHops = await listGraphConnections(db.pool, crawlId, { path: "/gone/", hops: 2 });
    expect(twoHops.length).toBeGreaterThan(oneHop.length);
  });
});

describe("listGraphExternalLinks", () => {
  it("returns recorded external evidence grouped by source, destination and anchor", async () => {
    const rows = await listGraphExternalLinks(db.pool, crawlId);
    expect(rows).toEqual([
      {
        fromUrl: `${host}/a/`,
        toUrl: "https://elsewhere.example/x",
        anchor: "ext",
        container: "main",
        isBoilerplate: false,
        count: 1,
      },
    ]);
    expect(await listGraphExternalLinks(db.pool, crawlId, { path: "/c/", hops: 1 })).toEqual([]);
  });
});

describe("listGraphBrokenEdges", () => {
  it("lists only a fetched target that served an error — never an unfetched or unresolved one", async () => {
    expect(await listGraphBrokenEdges(db.pool, crawlId)).toEqual([
      { fromUrl: `${host}/a/`, toUrl: `${host}/gone/`, statusCode: 404, anchor: "dead" },
    ]);
  });
});

describe("catalog helpers", () => {
  it("counts every link row per crawl", async () => {
    expect((await countLinksPerCrawl(db.pool, [crawlId])).get(crawlId)).toBe(9);
    expect((await countLinksPerCrawl(db.pool, [])).size).toBe(0);
  });

  it("finds each site's latest complete production crawl", async () => {
    const later = await insertCompleteCrawl(db.pool, siteId, new Date("2026-10-08T00:00:00Z"), {
      pages: [page("/")],
    });
    const latest = await listLatestCrawlsPerSite(db.pool);
    expect(latest).toEqual([expect.objectContaining({ siteId, crawlId: later.id })]);
  });
});
