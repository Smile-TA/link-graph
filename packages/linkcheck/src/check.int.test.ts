/**
 * `checkExternalUrls` against real Postgres, the real lychee binary and the fixture
 * server — the TTL, the sharing across sites, and the two refusals.
 *
 * The shared-and-cached behaviour is what PRD §6.1 calls "the single strongest argument
 * for centralisation", and it is only true if a row another site wrote counts here. That
 * is what the third test asserts, by watching the fixture server's request log rather
 * than by trusting the counts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTempDatabase,
  findExternalUrl,
  loadFixture,
  parseCrawlFixture,
  runMigrations,
  upsertExternalUrl,
  type TempDatabase,
} from "@link-graph/db";
import { startFixtureServer, type FixtureServer } from "@link-graph/crawl";
import { resolveLycheeBinary } from "./binary.js";
import { createLycheeRunner } from "./lychee.js";
import { checkExternalUrls, IncompleteLinkcheckError } from "./check.js";
import type { LinkcheckDeps } from "./check.js";

const FIXTURE_HOST = "linkcheck.fixture";
const NOW = new Date("2026-09-02T12:00:00.000Z");

let db: TempDatabase;
let server: FixtureServer;
let origin: string;
let deps: LinkcheckDeps;
/** integrity.com's crawl, and a second site linking at one of the same destinations. */
let crawlId: number;
let otherCrawlId: number;

/** `/live/` 200, `/gone/` 404, `/forbidden/` 403 — one of each verdict class. */
const handler = (path: string) => {
  if (path === "/live/")
    return {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html>x</html>",
    };
  if (path === "/gone/")
    return { status: 404, headers: { "content-type": "text/html" }, body: "gone" };
  if (path === "/forbidden/")
    return { status: 403, headers: { "content-type": "text/html" }, body: "denied" };
  return { status: 404, body: "" };
};

const externalLink = (from: string, to: string, anchor: string) => ({
  from,
  to,
  anchor,
  container: "main" as const,
});

beforeAll(async () => {
  db = await createTempDatabase("linkcheck");
  await runMigrations(db.pool);
  server = await startFixtureServer({ [FIXTURE_HOST]: handler });
  origin = server.originFor(FIXTURE_HOST);
  deps = {
    now: () => NOW,
    runner: createLycheeRunner({
      binaryPath: resolveLycheeBinary(process.env),
      hostIntervalMs: 10,
      requestTimeoutSeconds: 3,
      runTimeoutMs: 60_000,
    }),
  };

  const loaded = await loadFixture(
    db.pool,
    parseCrawlFixture({
      site: {
        siteId: "integrity-com",
        canonicalHost: "integrity.com",
        aliases: ["integrity.com", "www.integrity.com"],
        truthSource: "rest",
      },
      crawl: { status: "complete", startedAt: "2026-09-01T09:00:00.000Z" },
      pages: [
        {
          url: "https://integrity.com/",
          statusCode: 200,
          inTruthSource: true,
          indexable: true,
        },
        {
          url: "https://integrity.com/about-us/",
          statusCode: 200,
          inTruthSource: true,
          indexable: true,
        },
      ],
      links: [
        externalLink("https://integrity.com/", `${origin}/live/`, "Partner"),
        externalLink("https://integrity.com/", `${origin}/gone/`, "Award"),
        externalLink("https://integrity.com/", `${origin}/forbidden/`, "Ranking"),
        // The same destination from a second page. 30,456 external edges over 642
        // distinct targets on the real crawl, so the checker's unit is the target.
        externalLink("https://integrity.com/about-us/", `${origin}/live/`, "Partner"),
      ],
    }),
  );
  crawlId = loaded.crawlId;

  const other = await loadFixture(
    db.pool,
    parseCrawlFixture({
      site: {
        siteId: "lionstreet-com",
        canonicalHost: "lionstreet.com",
        aliases: ["lionstreet.com", "www.lionstreet.com"],
        truthSource: "rest",
      },
      crawl: { status: "complete", startedAt: "2026-09-01T10:00:00.000Z" },
      pages: [
        {
          url: "https://lionstreet.com/",
          statusCode: 200,
          inTruthSource: true,
          indexable: true,
        },
      ],
      links: [externalLink("https://lionstreet.com/", `${origin}/live/`, "Integrity")],
    }),
  );
  otherCrawlId = other.crawlId;
});

afterAll(async () => {
  await server.close();
  await db.drop();
});

beforeEach(async () => {
  await db.pool.query("DELETE FROM external_urls");
});

describe("checkExternalUrls", () => {
  it("checks each distinct external URL once and records what came back", async () => {
    const before = server.requests.length;
    const result = await checkExternalUrls(db.pool, crawlId, deps);

    // Four external edges, three distinct targets, three requests.
    expect(result).toEqual({
      external: 3,
      due: 3,
      fresh: 0,
      recorded: 3,
      checked: 3,
      ok: 1,
      broken: 1,
      unverified: 1,
      conclusive: 2,
    });
    expect(server.requests.slice(before)).toHaveLength(3);

    expect(await findExternalUrl(db.pool, `${origin}/live/`)).toEqual({
      urlNormalized: `${origin}/live/`,
      lastChecked: NOW,
      statusCode: 200,
      unverified: false,
      detail: null,
    });
    // PRD §6.1: a third-party 403 is unverified, never broken — and it says why.
    const forbidden = await findExternalUrl(db.pool, `${origin}/forbidden/`);
    expect(forbidden?.statusCode).toBe(403);
    expect(forbidden?.unverified).toBe(true);
    expect(forbidden?.detail).toMatch(/403/);
    const gone = await findExternalUrl(db.pool, `${origin}/gone/`);
    expect([gone?.statusCode, gone?.unverified, gone?.detail]).toEqual([
      404,
      false,
      null,
    ]);
  });

  it("makes no request at all on a second run inside the TTL", async () => {
    await checkExternalUrls(db.pool, crawlId, deps);
    const before = server.requests.length;
    const again = await checkExternalUrls(db.pool, crawlId, deps);

    expect(server.requests.slice(before)).toEqual([]);
    // **`external` is 3 while `checked` is 0**, which is the whole reason both are
    // carried: "0 broken" out of 0 checked is not a statement about the site.
    expect(again).toMatchObject({ external: 3, due: 0, fresh: 3, checked: 0, broken: 0 });
  });

  /**
   * PRD §6.1: "External links are checked once, centrally, and shared across all 165
   * sites… the same third-party URL appears across many sites and must not be checked
   * many times." The join in `listExternalUrlsDue` has no site in it, and this is what
   * that buys.
   */
  it("does not re-check a URL another site's run already checked", async () => {
    await checkExternalUrls(db.pool, otherCrawlId, deps);
    const before = server.requests.length;
    const result = await checkExternalUrls(db.pool, crawlId, deps);

    // `/live/` is the URL both sites link to; only the other two are asked about.
    expect(server.requests.slice(before).map((r) => r.replace(FIXTURE_HOST, ""))).toEqual(
      ["/forbidden/", "/gone/"],
    );
    expect(result).toMatchObject({ external: 3, due: 2, fresh: 1, checked: 2 });
  });

  it("checks a URL again once its TTL has run out", async () => {
    await checkExternalUrls(db.pool, crawlId, deps, { ttlHours: 1 });
    const later: LinkcheckDeps = {
      ...deps,
      now: () => new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
    };
    const result = await checkExternalUrls(db.pool, crawlId, later, { ttlHours: 1 });
    expect(result).toMatchObject({ due: 3, checked: 3 });
  });

  /**
   * A row that exists with a NULL `last_checked` is due (003_external_urls.sql allows
   * one). Reading "there is a row" as "it has been checked" would drop the URL out of
   * every future run — a link never checked and never reported as unchecked.
   */
  it("treats a row that was never checked as due, not as checked long ago", async () => {
    await upsertExternalUrl(db.pool, {
      urlNormalized: `${origin}/live/`,
      lastChecked: null,
      statusCode: null,
      unverified: false,
      detail: null,
    });
    const result = await checkExternalUrls(db.pool, crawlId, deps);
    expect(result).toMatchObject({ due: 3, checked: 3 });
  });

  /**
   * The §1 test of this file. Every URL comes back unanswerable — the shape of our own
   * egress being broken — and `last_checked` is what the TTL reads, so writing these
   * rows would silence the checker for a week while the run reported zero broken links.
   */
  it("writes nothing and throws when it could not tell anything about any URL", async () => {
    // A crawl whose external links point at a port nothing listens on: every result is a
    // connection failure, which is exactly what a broken egress looks like.
    const dead = await loadFixture(
      db.pool,
      parseCrawlFixture({
        site: {
          siteId: "whyaim-com",
          canonicalHost: "whyaim.com",
          aliases: ["whyaim.com"],
          truthSource: "rest",
        },
        crawl: { status: "complete", startedAt: "2026-09-01T11:00:00.000Z" },
        pages: [
          {
            url: "https://whyaim.com/",
            statusCode: 200,
            inTruthSource: true,
            indexable: true,
          },
        ],
        links: [
          externalLink("https://whyaim.com/", "http://127.0.0.1:1/one/", "One"),
          externalLink("https://whyaim.com/", "http://127.0.0.1:1/two/", "Two"),
        ],
      }),
    );

    const error = await checkExternalUrls(db.pool, dead.crawlId, deps).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(IncompleteLinkcheckError);
    const incomplete = error as IncompleteLinkcheckError;
    expect(incomplete.message).toMatch(/not one of the 2 URLs/);
    expect(incomplete.result).toMatchObject({ checked: 2, unverified: 2, recorded: 0 });

    // Nothing recorded, so the next run asks again rather than reading a fresh row.
    expect(await findExternalUrl(db.pool, "http://127.0.0.1:1/one/")).toBeNull();
    const { rows } = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM external_urls",
    );
    expect(rows[0]?.n).toBe(0);
  });

  /**
   * The layered defence 011_finding_reviews.sql set the precedent for: the rule also
   * holds against a hand-written `psql` fix-up and against step 11's API, not only
   * against this package's own code path.
   */
  it("has a database that refuses an unverified row with no reason recorded", async () => {
    await expect(
      db.pool.query(
        `INSERT INTO external_urls (url_normalized, last_checked, status_code, unverified)
         VALUES ('https://example.invalid/', now(), 403, true)`,
      ),
    ).rejects.toThrow(/external_urls_unverified_has_detail/);
    await expect(
      db.pool.query(
        `INSERT INTO external_urls (url_normalized, last_checked, status_code, unverified,
                                    detail)
         VALUES ('https://example.invalid/', now(), 403, true, E'\t')`,
      ),
    ).rejects.toThrow(/external_urls_unverified_has_detail/);
  });
});
