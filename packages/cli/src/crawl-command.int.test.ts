/**
 * `link-graph crawl <site-id>` end to end: real Postgres, a local fixture server, and
 * the whole pipeline the command wires — resolve the truth source (step 5), crawl
 * (step 6), analyse (step 4), print the orphan table.
 *
 * **Nothing here reaches the estate.** Wordfence bans the source IP for an hour on the
 * first 503 (PRD §5.1), so a suite that crawled a real host would be a suite nobody
 * could run twice; the site is 403bplan.net served from its production captures, whose
 * answer is known independently — step 4 derived 4 true orphans and 240 edges from these
 * same bytes by hand.
 *
 * Every assertion below is about what a *person or a cron job sees*: the exit code, and
 * what went to stdout and stderr. That is the deliverable of this step, so it is what is
 * tested rather than the internal return value.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  countCrawlRows,
  createTempDatabase,
  databaseUrl,
  findCrawlMetrics,
  findSiteBySlug,
  listCrawlDiffs,
  runMigrations,
  upsertSite,
  type SiteInput,
  type SiteRow,
  type TempDatabase,
} from "@link-graph/db";
import {
  createHostLimiter,
  serve403bplan,
  startFixtureServer,
  HTML,
  type CrawlDeps,
  type FixtureHandler,
  type FixtureServer,
  type HostLimiter,
} from "@link-graph/crawl";
import type { HttpResult, TruthDeps } from "@link-graph/truth";
import { HOST, serve403bplanSite } from "./testing/403bplan-site.js";
import { EXIT } from "./exit.js";
import { main } from "./main.js";
import type { CrawlCommandDeps } from "./run.js";

let db: TempDatabase;
let dbUrl: string;
let limiter: HostLimiter;
const servers: FixtureServer[] = [];

beforeAll(async () => {
  db = await createTempDatabase("cli");
  await runMigrations(db.pool);
  limiter = createHostLimiter();
  // The command builds its own pool from DATABASE_URL, so the test has to name the
  // throwaway database the same way. Asked of the server rather than reconstructed, so
  // this cannot drift from whatever `createTempDatabase` chose.
  const { rows } = await db.pool.query<{ name: string }>(
    `SELECT current_database() AS name`,
  );
  const url = new URL(databaseUrl());
  url.pathname = `/${rows[0]?.name ?? ""}`;
  dbUrl = url.toString();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

afterAll(async () => {
  await limiter.stop();
  await db.drop();
});

/** A fixed clock, so nothing stored depends on when the suite ran (guide §4.4). */
const now = () => new Date("2026-08-24T12:00:00Z");

async function serve(handler: FixtureHandler): Promise<FixtureServer> {
  const server = await startFixtureServer({ [HOST]: handler });
  servers.push(server);
  return server;
}

/**
 * The truth resolver's fetch, aimed at the fixture server. Not `packages/truth`'s own
 * `createHttpFetcher`: that one paces itself at 1 req/s against Wordfence, which would
 * cost four seconds of wall clock per resolution here for no coverage. Real sockets,
 * real status lines, real headers; only the connection is redirected, exactly as
 * `fixture-server.ts` does it for the crawler.
 */
function fixtureTruthDeps(server: FixtureServer): TruthDeps {
  return {
    async get(url: string): Promise<HttpResult> {
      const target = new URL(url);
      const local = `${server.originFor(target.host)}${target.pathname}${target.search}`;
      try {
        const response = await fetch(local, { redirect: "manual" });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
        return {
          kind: "response",
          status: response.status,
          headers,
          body: await response.text(),
        };
      } catch (error) {
        return { kind: "transport-error", detail: String(error) };
      }
    },
  };
}

/**
 * Deps that make any HTTP at all a test failure. The two registry refusals claim to
 * happen "before doing anything", and with real deps a reordering would send this suite
 * at 403bplan.net itself — 1 req/s against the estate, from a test whose header says it
 * never touches it. Asserted rather than named.
 */
const refuse = (url: string): never => {
  throw new Error(`fetched ${url} before the registry refusal`);
};
const refuseToFetch: Partial<CrawlCommandDeps> = {
  truth: { get: refuse },
  crawl: { fetcher: { get: refuse } },
};

let siteSequence = 0;

/**
 * A registry row. `truthSource: null` — not resolved yet — because that is the state a
 * site is in before this command has ever run on it, and resolving it is the command's
 * first job. `rateLimit` is 500 rather than the production 1 for the reason step 6 gives:
 * the limiter has its own unit test, and pacing 13 pages at a second apiece would spend
 * the whole tier's budget on one test.
 */
async function makeSite(overrides: Partial<SiteInput> = {}): Promise<SiteRow> {
  return upsertSite(db.pool, {
    siteId: `403bplan-net-${siteSequence++}`,
    canonicalHost: HOST,
    aliases: [HOST, `www.${HOST}`],
    stageHost: null,
    enabled: true,
    truthSource: null,
    crawlerMode: "http",
    crawlScope: "full",
    sampleCeiling: null,
    rateLimit: 500,
    ignorePaths: [],
    ...overrides,
  });
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
      env: { DATABASE_URL: dbUrl },
    },
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
  };
}

const deps = (server: FixtureServer): Partial<CrawlCommandDeps> => ({
  truth: fixtureTruthDeps(server),
  crawl: { fetcher: server.fetcher, limiter, now } satisfies Partial<CrawlDeps>,
});

/** Postgres' own row version, so "untouched" can be told from "still correct". */
async function rowVersion(site: SiteRow): Promise<string> {
  const { rows } = await db.pool.query<{ xmin: string }>(
    `SELECT xmin::text AS xmin FROM sites WHERE id = $1`,
    [site.id],
  );
  if (rows[0] === undefined) throw new Error(`no sites row ${site.id}`);
  return rows[0].xmin;
}

/** The one crawl this site has, looked up rather than assumed to be id 1. */
async function crawlIdOf(site: SiteRow): Promise<number> {
  const { rows } = await db.pool.query<{ id: number }>(
    `SELECT id FROM crawls WHERE site_id = $1`,
    [site.id],
  );
  if (rows.length !== 1) throw new Error(`expected one crawl, found ${rows.length}`);
  return rows[0]?.id ?? 0;
}

async function run(site: SiteRow, server: FixtureServer) {
  const io = capture();
  const code = await main(["crawl", site.siteId], io.io, deps(server));
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

describe("link-graph crawl", () => {
  it("resolves, crawls, analyses and prints the orphan table", async () => {
    const server = await serve(serve403bplanSite);
    const site = await makeSite();
    const result = await run(site, server);

    expect(result.stderr, "no failure expected").not.toMatch(/error/i);
    expect(result.code).toBe(EXIT.ok);

    // Progress, on stderr, naming each of the three steps as it starts. A crawl of a
    // real site is ~33 minutes at 1 req/s and a command that says nothing for half an
    // hour is a command people kill, so silence here is a defect and not a detail.
    expect(result.stderr).toMatch(/resolving the truth source for 403bplan\.net/);
    expect(result.stderr).toMatch(/crawling 403bplan\.net: 13 inventory URL\(s\)/);
    expect(result.stderr).toMatch(/analysing crawl \d+: 13 page\(s\)/);

    // The four true orphans, and they are the same four `analyse.int.test.ts` derived
    // by hand from these same bytes — reached here through a different door: a truth
    // source resolved over HTTP and a crawl, rather than a hand-built fixture JSON.
    for (const path of [
      "/newsletter-signup/",
      "/newsletters/",
      "/plan-participant/online-access/",
      "/test-pay-button/",
    ]) {
      expect(result.stdout, path).toContain(`https://${HOST}${path}`);
    }
    // ...and nothing else. `/financial-advisor/` is linked from the header nav of all 13
    // pages; a report that named it too is the false positive PRD §13 says destroys
    // trust within two weeks.
    expect(result.stdout).not.toContain(`https://${HOST}/financial-advisor/`);
    expect(result.stdout).toMatch(/Orphans .*\(4\)/);
    expect(result.stdout).toMatch(/13 page\(s\)/);
    expect(result.stdout).toMatch(/240 link\(s\)/);
    // A whole row, so that the status column carries the status the crawl actually
    // recorded. `listPages` orders by url_normalized, so the index is deterministic.
    expect(result.stdout).toContain(`    1     200  https://${HOST}/newsletter-signup/`);

    // The row a later step reads agrees with the table just printed.
    const metrics = await findCrawlMetrics(db.pool, await crawlIdOf(site));
    expect(metrics).toMatchObject({
      orphans: 4,
      orphansUnknownReason: null,
      linked: 9,
      excluded: 0,
      notInTruthSource: 0,
      undetectable: 0,
    });
  });

  /**
   * Step 13: a second crawl of the same, unchanged site diffs cleanly against the first
   * and keeps both crawls' row-level detail, because two is nowhere near the 12-crawl
   * retention window (PRD §7). The content here never changes between runs, so the
   * diff being empty is the correct answer, not a false negative — what this proves is
   * that the wiring runs end to end without turning a second successful crawl into a
   * failed command.
   */
  it("diffs against the previous crawl and keeps both under the retention window", async () => {
    const site = await makeSite();
    const first = await run(site, await serve(serve403bplanSite));
    expect(first.code).toBe(EXIT.ok);
    const firstCrawlId = await crawlIdOf(site);

    const second = await run(site, await serve(serve403bplanSite));
    expect(second.code).toBe(EXIT.ok);
    const { rows } = await db.pool.query<{ id: number }>(
      `SELECT id FROM crawls WHERE site_id = $1 ORDER BY id`,
      [site.id],
    );
    const secondCrawlId = rows[1]?.id;
    if (secondCrawlId === undefined) throw new Error("expected two crawls");

    expect(await listCrawlDiffs(db.pool, secondCrawlId)).toEqual([]);
    expect((await countCrawlRows(db.pool, firstCrawlId)).pages).toBe(13);
    expect((await countCrawlRows(db.pool, secondCrawlId)).pages).toBe(13);
  });

  /**
   * The resolution is written back to the registry, because `analyse` reads
   * `sites.truth_source` to decide whether the orphan question can be answered at all —
   * so a row left at NULL would report `no_truth_source` for a site with 13 REST pages.
   */
  it("records the resolved truth source on the site", async () => {
    const server = await serve(serve403bplanSite);
    const site = await makeSite();
    expect(site.truthSource).toBeNull();

    const result = await run(site, server);
    expect(result.code).toBe(EXIT.ok);
    expect((await findSiteBySlug(db.pool, site.siteId))?.truthSource).toBe("rest");
    // Said out loud, because a registry value changing under a site is a fact about the
    // site rather than bookkeeping: a host that used to answer REST and now does not is
    // the difference between an orphan count and a coverage gap.
    expect(result.stdout).toContain("registry updated from unresolved");
  });

  /**
   * And the row is left alone — not merely left correct — when it already says what the
   * resolution found. `upsertSite` writes all eleven columns, nine of which belong to the
   * curation overlay (PRD §3), so "the value is still right" would pass while the command
   * rewrote them all. `xmin` is the row's version: unchanged means untouched.
   */
  it("does not rewrite the registry row when the truth source has not moved", async () => {
    const server = await serve(serve403bplanSite);
    const site = await makeSite({ truthSource: "rest" });
    const before = await rowVersion(site);
    const result = await run(site, server);

    expect(result.code).toBe(EXIT.ok);
    expect(await rowVersion(site)).toBe(before);
    expect(result.stdout).not.toContain("registry updated");
  });

  it("writes the row when the truth source has moved, and only then", async () => {
    const server = await serve(serve403bplanSite);
    const site = await makeSite({ truthSource: "none" });
    const before = await rowVersion(site);

    expect((await run(site, server)).code).toBe(EXIT.ok);
    expect(await rowVersion(site)).not.toBe(before);
    expect((await findSiteBySlug(db.pool, site.siteId))?.truthSource).toBe("rest");
  });

  /**
   * Engineering guide §1, in the place the project exists to protect: a crawl that
   * stopped early has an arbitrary subset of the site's pages, so it must not print a
   * table at all — a short orphan list reads as good news.
   */
  it("exits non-zero and prints no table when the crawl ends early", async () => {
    // Measured on whyaim.com 2026-08-18: 503 with `retry-after: 3600`, a one-hour ban.
    const server = await serve((path) =>
      path === "/disclosures/"
        ? { status: 503, headers: { "retry-after": "3600" }, body: "" }
        : serve403bplanSite(path),
    );
    const result = await run(await makeSite(), server);

    expect(result.code).toBe(EXIT.failed);
    expect(result.code).not.toBe(EXIT.ok);
    expect(result.stderr).toMatch(/partial/i);
    expect(result.stderr).toMatch(/503/);
    // Nothing at all on stdout: not a table, not a count, not a zero.
    expect(result.stdout).toBe("");
  });

  /**
   * PRD §2's Undetectable and PRD §13's coverage gap: 47 sites have no truth source, and
   * a run on one of them must not read as a clean bill of health.
   */
  it("exits non-zero with a reason when the site has no truth source", async () => {
    // Every truth-source path 404s — the 123.planenroll.com cohort's shape — while the
    // pages still serve, so the site is crawlable and simply not answerable.
    const server = await serve(serve403bplan);
    const site = await makeSite();
    const result = await run(site, server);

    expect(result.code).toBe(EXIT.undetectable);
    expect(result.code).not.toBe(EXIT.ok);
    expect(result.stdout).toMatch(/Orphans\s+unknown/);
    expect(result.stdout).toContain("no_truth_source");
    expect(result.stdout).toContain("? orphan,");
    expect(result.stdout).not.toMatch(/\d+ orphan,/);
    expect((await findSiteBySlug(db.pool, site.siteId))?.truthSource).toBe("none");
  });

  /**
   * **A resolution that lost one of its two sources exits 3, decided 2026-08-25
   * (PRD §15).** WP REST is blocked here and the sitemap answers, so the inventory is the
   * sitemap's view of the site. On 403bplan.net the two list the same 13 URLs, so the
   * four orphans are unchanged and the table is right — but on integrity.com REST lists
   * 124 pages and the sitemap 96, so the same shape differences against 96 and says
   * nothing about the other 28. The count is therefore not of the site, and the code that
   * means "not an answer for the whole site" is the one to return.
   *
   * This test previously pinned the opposite (exit 0) precisely so that changing it would
   * be a decision rather than an accident. It was.
   */
  it("exits 3 when a truth source was lost, and says so in the table", async () => {
    // Wordfence answering 403 to /wp-json/ is the measured shape (PRD §5.1).
    const server = await serve((path) =>
      path.startsWith("/wp-json/")
        ? { status: 403, headers: { "content-type": "text/html" }, body: "blocked" }
        : serve403bplanSite(path),
    );
    const site = await makeSite();
    const result = await run(site, server);

    expect(result.code).toBe(EXIT.undetectable);
    expect(result.code).not.toBe(EXIT.ok);
    expect((await findSiteBySlug(db.pool, site.siteId))?.truthSource).toBe("sitemap");
    expect(result.stdout).toContain("rest-unusable");
    expect(result.stdout).toContain("HTTP 403");
    // The inventory came from one source, and the report says which one was not read
    // rather than printing a zero for it.
    expect(result.stdout).toContain("(REST not read, sitemap 13)");
    expect(result.stdout).toMatch(/only as complete as the inventory/);
    // The table still lists what it found — the pages are real orphans, and suppressing
    // them would trade a false clean bill of health for a false empty one.
    expect(result.stdout).toMatch(/Orphans .*\(4\)/);
    // But the summary line agrees with the exit code rather than reading as complete.
    expect(result.stdout).toMatch(/Orphans\s+4 of an inventory that is short/);
  });

  /**
   * PRD §15: a templated site is sampled by policy, and the consequence is stated rather
   * than hidden. Same bytes as the passing case, different scope, and no zero either way.
   */
  it("exits non-zero with 'sampled' for a crawl that covered a ceiling", async () => {
    const server = await serve(serve403bplanSite);
    const site = await makeSite({ crawlScope: "sample", sampleCeiling: 5 });
    const result = await run(site, server);

    expect(result.code).toBe(EXIT.undetectable);
    expect(result.stdout).toContain("sampled");
    expect(result.stdout).not.toContain("no_truth_source");
    // 5 fetched of 13 queued, and the 8 the ceiling skipped are named on the same line:
    // a `complete` crawl that covered part of the site has to say which part.
    expect(result.stdout).toContain(
      "5 page(s) of a 13-URL inventory, 8 queued URL(s) never fetched",
    );
  });

  /**
   * `analyse`'s refusals carry the sentence a reader needs, so the command surfaces them
   * instead of turning them into a missing number. A homepage that never served makes
   * every other page unreachable and every truth-source page an orphan — a complete,
   * plausible, entirely wrong report.
   */
  it("surfaces an analysis refusal instead of printing the numbers anyway", async () => {
    const server = await serve((path) =>
      path === "/" ? { status: 500, headers: HTML, body: "" } : serve403bplanSite(path),
    );
    const result = await run(await makeSite(), server);

    expect(result.code).toBe(EXIT.failed);
    expect(result.stderr).toMatch(/returned 500/);
    expect(result.stderr).toMatch(/reachability has no usable root/);
    expect(result.stdout).toBe("");
  });

  it("refuses a site that is not in the registry, before doing anything", async () => {
    const io = capture();
    const code = await main(["crawl", "not-a-site"], io.io, refuseToFetch);
    expect(code).toBe(EXIT.usage);
    expect(io.stderr()).toContain("not-a-site");
    expect(io.stdout()).toBe("");
  });

  /**
   * PRD §3.1: an entry the platform does not serve enters the registry as
   * `enabled: false`, and the liveness probe flips it on when it migrates. Crawling one
   * anyway would produce a page list for a site that is not deployed.
   */
  it("refuses a disabled site", async () => {
    const site = await makeSite({ enabled: false });
    const io = capture();
    const code = await main(["crawl", site.siteId], io.io, refuseToFetch);
    expect(code).toBe(EXIT.usage);
    expect(io.stderr()).toMatch(/enabled|disabled/);
    expect(io.stdout()).toBe("");
  });
});
