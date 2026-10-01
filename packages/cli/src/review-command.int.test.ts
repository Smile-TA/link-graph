/**
 * `link-graph note` and `link-graph report` end to end: real Postgres, a real crawl of a
 * real site, and the four tests step 7.6 is judged by.
 *
 * **The site is 403bplan.net, loaded from its production captures rather than crawled**
 * — the same 13 pages, 240 links and 4 hand-derived orphans `analyse.int.test.ts` and
 * `crawl-command.int.test.ts` use, so nothing here invents a finding. Nothing reaches
 * the estate (PRD §5.1: the first 503 bans the IP for an hour), and nothing here needs
 * the crawler: `report` is a read path, which is the point of it.
 *
 * Every assertion is about what a person or a cron job sees — the exit code, stdout,
 * stderr — plus one that is about what the database still holds, because "a review never
 * changes a measured number" (PRD §7.1 rule 1) is a claim about rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyse } from "@link-graph/analyse";
import { build403bplanCrawl, type FixtureCrawlJson } from "@link-graph/analyse";
import {
  createTempDatabase,
  findSiteBySlug,
  insertCompleteCrawl,
  insertCrawlDiff,
  listFindingReviews,
  loadFixture,
  parseCrawlFixture,
  runMigrations,
  upsertSite,
  type FindingKind,
  type TempDatabase,
} from "@link-graph/db";
import { EXIT } from "./exit.js";
import { main } from "./main.js";

let db: TempDatabase;

beforeAll(async () => {
  db = await createTempDatabase("review");
  await runMigrations(db.pool);
});

afterAll(async () => {
  await db.drop();
});

/** A fixed clock, so "13 day(s) ago" is a fact about the data (guide §4.4). */
const NOW = new Date("2026-09-02T09:08:15.000Z");
const deps = { now: () => NOW };

const HOST = "https://403bplan.net";
/** The four true orphans, hand-derived in step 4 from these same bytes. */
const ORPHANS = [
  "/newsletter-signup/",
  "/newsletters/",
  "/plan-participant/online-access/",
  "/test-pay-button/",
];

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
      // The commands build their own pool from DATABASE_URL, so the test points it at
      // the throwaway database `createTempDatabase` made.
      env: { DATABASE_URL: db.url, USER: "smile" },
    },
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
  };
}

async function run(argv: readonly string[]) {
  const io = capture();
  const code = await main(argv, io.io, deps);
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

let sequence = 0;

/** A site of its own per test, so one test's reviews cannot answer another's report. */
const newSite = (): string => `403bplan-net-${sequence++}`;

interface CrawlOptions {
  /**
   * Serve `/contact-us/` as a 404. The status is the one thing these captures cannot
   * carry (the saved bodies have no status line), so stipulating it is what the fixture
   * is for — and it turns 15 real edges from 13 real pages into a broken internal link
   * whose blast radius is measurable.
   */
  readonly contactUsBroken?: boolean;
  /**
   * Add the real `/?s=403b` capture, which carries the same header nav as every other
   * page. Measured: it takes `/contact-us/`'s distinct linking pages from 13 to 14.
   */
  readonly includeSearchPage?: boolean;
  /** Strip the truth source, so `analyse` reports `orphans: null` (PRD §2). */
  readonly noTruthSource?: boolean;
}

/**
 * One analysed crawl of the site. `loadFixture` writes the crawl and `analyse` writes
 * `pages.class` and `crawl_metrics`, exactly as the crawl command would.
 */
async function crawlOf(slug: string, options: CrawlOptions = {}): Promise<number> {
  const built = build403bplanCrawl(
    options.includeSearchPage === true ? { includeSearchPage: true } : {},
  );
  const json: FixtureCrawlJson = {
    ...built,
    site: { ...built.site, siteId: slug },
    crawl: { ...built.crawl },
    pages:
      options.contactUsBroken === true
        ? built.pages.map((page) =>
            page.url === `${HOST}/contact-us/` ? { ...page, statusCode: 404 } : page,
          )
        : built.pages,
  };
  if (options.noTruthSource === true) {
    json.site["truthSource"] = "none";
    // The fixture contract refuses an inventory size on a site that has none.
    delete json.crawl["truthSourceUrls"];
    delete json.crawl["truthSourceSitemapUrls"];
    delete json.crawl["truthSourceRestUrls"];
  }
  const { crawlId } = await loadFixture(db.pool, parseCrawlFixture(json), {
    now: () => NOW,
  });
  await analyse(db.pool, crawlId);
  return crawlId;
}

/**
 * The metrics row and every page's class, with Postgres' own row versions. `xmin`
 * unchanged means the row was not rewritten — "still correct" would pass while something
 * rewrote it with the same values.
 */
async function measured(crawlId: number): Promise<string> {
  const metrics = await db.pool.query<{ dump: string }>(
    `SELECT xmin::text || ' ' || to_jsonb(m)::text AS dump
     FROM crawl_metrics m WHERE crawl_id = $1`,
    [crawlId],
  );
  const pages = await db.pool.query<{ dump: string }>(
    `SELECT xmin::text || ' ' || url_normalized || ' ' || coalesce(class, 'null') AS dump
     FROM pages WHERE crawl_id = $1 ORDER BY url_normalized`,
    [crawlId],
  );
  return [...metrics.rows, ...pages.rows].map((row) => row.dump).join("\n");
}

/** The site's reviews, read straight from the table rather than off the report. */
async function reviewsOf(slug: string, kind: FindingKind = "orphan") {
  const site = await findSiteBySlug(db.pool, slug);
  if (site === null) throw new Error(`no sites row for ${slug}`);
  return listFindingReviews(db.pool, site.id, kind);
}

const noteOrphan = (slug: string, path: string, message: string) =>
  run(["note", slug, "orphan", path, "--intentional", "-m", message]);

describe("link-graph note + report", () => {
  /**
   * **The step's first §1 test.** Review every orphan on the site and the measured
   * numbers must not move by one byte, while the report says "4 orphans, 4 reviewed" —
   * never "no orphans", never 0. A review that suppressed a finding would be
   * indistinguishable from a site that never had one.
   */
  it("leaves crawl_metrics byte-identical when every orphan is reviewed", async () => {
    const site = newSite();
    const crawlId = await crawlOf(site);
    const before = await measured(crawlId);

    for (const path of ORPHANS) {
      const noted = await noteOrphan(site, path, `judged: ${path}`);
      expect(noted.stderr, path).toBe("");
      expect(noted.code, path).toBe(EXIT.ok);
      expect(noted.stdout).toContain(`noted: orphan ${HOST}${path} — intentional`);
    }

    expect(await measured(crawlId)).toBe(before);

    const report = await run(["report", site]);
    expect(report.code).toBe(EXIT.ok);
    expect(report.stdout).toContain(
      "Orphans        4 — 0 new, 0 changed since review, 4 reviewed " +
        "(4 intentional, 0 acknowledged)",
    );
    // The negative that can actually fail: a suppressing implementation would print
    // "Orphans        0" here. ("no orphans" appears in no format string, so asserting
    // its absence proves nothing on its own.)
    expect(report.stdout).not.toContain("Orphans        0");
    // All four still listed, numbered to the measured total.
    for (const [index, path] of ORPHANS.entries()) {
      expect(report.stdout).toContain(
        `${String(index + 1).padStart(5)}     200  ${HOST}${path}`,
      );
    }
    expect(report.stdout).toContain("intentional, judged 0 day(s) ago by smile");
  });

  /**
   * **The second §1 test.** `pages` and `links` rows are rolled up after twelve crawls
   * (PRD §7), so a review keyed on one would evaporate on schedule. This deletes the
   * crawl the finding was recorded in, crawls again, and the judgement is still attached
   * to the finding.
   */
  it("keeps a review when the crawl its finding came from is deleted", async () => {
    const site = newSite();
    const first = await crawlOf(site);
    expect(
      (await noteOrphan(site, "/test-pay-button/", "a leftover test page")).code,
    ).toBe(EXIT.ok);

    await db.pool.query(`DELETE FROM crawls WHERE id = $1`, [first]);
    const { rowCount } = await db.pool.query(`SELECT 1 FROM crawls WHERE id = $1`, [
      first,
    ]);
    expect(rowCount).toBe(0);

    // The same site, crawled again: the finding comes back and its review is still on it.
    await crawlOf(site);
    const report = await run(["report", site]);
    expect(report.code).toBe(EXIT.ok);
    expect(report.stdout).toContain(
      "Orphans        4 — 3 new, 0 changed since review, 1 reviewed",
    );
    expect(report.stdout).toContain("a leftover test page");
  });

  /**
   * **Step 13's own gap, closed.** PRD §7.1 left this open: a finding that disappears
   * and later returns must not silently reactivate its old review. Unlike the previous
   * test — where the finding was continuously present and only the crawl row that
   * recorded it was deleted — this one plants `crawl_diffs` history that genuinely says
   * the subject resolved and then reappeared after the review was written, and asserts
   * the report ranks it as `new` rather than reusing the stale judgement.
   */
  it("re-ranks a reviewed finding as new once history shows it disappeared and came back", async () => {
    const site = newSite();
    const subject = "/test-pay-button/";
    const crawlId = await crawlOf(site);
    expect((await noteOrphan(site, subject, "reviewed once")).code).toBe(EXIT.ok);

    const siteRow = await findSiteBySlug(db.pool, site);
    if (siteRow === null) throw new Error(`no site row for ${site}`);
    const siteId: number = siteRow.id;
    const url = `${HOST}${subject}`;

    async function laterCrawl(finishedAt: string): Promise<number> {
      const crawl = await insertCompleteCrawl(db.pool, siteId, new Date(finishedAt));
      return crawl.id;
    }

    // Both events dated after NOW, which is when the review above was written.
    const resolvedCrawl = await laterCrawl("2026-09-05T00:00:00.000Z");
    await insertCrawlDiff(db.pool, {
      fromCrawlId: crawlId,
      toCrawlId: resolvedCrawl,
      kind: "orphan_resolved",
      url,
      detail: null,
    });
    const appearedCrawl = await laterCrawl("2026-09-10T00:00:00.000Z");
    await insertCrawlDiff(db.pool, {
      fromCrawlId: resolvedCrawl,
      toCrawlId: appearedCrawl,
      kind: "orphan_appeared",
      url,
      detail: null,
    });

    // The crawl `report` actually reads: the finding is present again. `crawlOf`'s
    // fixture always stamps `finished_at` as the same fixed instant (guide §4.4), so
    // it is nudged later here — otherwise `findLatestCompleteCrawl` would keep
    // reading the synthetic `appearedCrawl` above, which has no `crawl_metrics` row.
    const finalCrawl = await crawlOf(site);
    await db.pool.query(`UPDATE crawls SET finished_at = $2 WHERE id = $1`, [
      finalCrawl,
      new Date("2026-09-15T00:00:00.000Z"),
    ]);
    const report = await run(["report", site]);
    if (report.code !== EXIT.ok) throw new Error(report.stderr);
    expect(report.stdout).toContain(
      "Orphans        4 — 4 new, 0 changed since review, 0 reviewed",
    );
  });

  /**
   * **The third §1 test**, on real edges. `/contact-us/` serving a 404 is linked by 15
   * edges from 13 distinct pages; adding the real `/?s=403b` page — which carries the
   * same header nav — makes it 14. PRD §7.1 rule 5: an acknowledged 404 linked from 18
   * pages must not stay quiet once it is linked from 40.
   */
  it("re-surfaces an acknowledged broken link when its blast radius moves", async () => {
    const site = newSite();
    await crawlOf(site, { contactUsBroken: true });

    const noted = await run([
      "note",
      site,
      "broken_internal_link",
      "/contact-us/",
      "--acknowledged",
      "-m",
      "the page is coming back next sprint",
    ]);
    expect(noted.code).toBe(EXIT.ok);
    expect(noted.stdout).toContain(`noted: broken_internal_link ${HOST}/contact-us/`);

    const reviewed = await run(["report", site]);
    expect(reviewed.stdout).toContain(
      "Broken links   1 target(s) — 0 new, 0 changed since review, 1 reviewed " +
        "(0 intentional, 1 acknowledged)",
    );
    expect(reviewed.stdout).toContain(`    1     404     13  ${HOST}/contact-us/`);

    // Re-crawled unchanged: the same 13 pages link to it, so the review still holds.
    await crawlOf(site, { contactUsBroken: true });
    const again = await run(["report", site]);
    expect(again.stdout).toContain(
      "Broken links   1 target(s) — 0 new, 0 changed since review, 1 reviewed",
    );

    // One more page of the site links to it — 13 → 14 — and the review is now stale.
    await crawlOf(site, { contactUsBroken: true, includeSearchPage: true });
    const changed = await run(["report", site]);
    expect(changed.stdout).toContain(
      "Broken links   1 target(s) — 0 new, 1 changed since review, 0 reviewed",
    );
    expect(changed.stdout).toContain(`    1     404     14  ${HOST}/contact-us/`);
    expect(changed.stdout).toContain("the evidence has moved since it was judged");
  });

  /**
   * PRD §7.1 rule 4 at the command line. The state vocabulary has no `fixed` and the
   * CHECK in `011` refuses one; this is the refusal a person actually meets, and it
   * says why rather than calling the flag unknown.
   */
  it("refuses --fixed and says why the state does not exist", async () => {
    const site = newSite();
    await crawlOf(site);
    const result = await run([
      "note",
      site,
      "orphan",
      "/test-pay-button/",
      "--fixed",
      "-m",
      "someone linked it",
    ]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/no "fixed" review state/);
    expect(result.stdout).toBe("");
    expect(await reviewsOf(site)).toHaveLength(0);
  });

  /**
   * The subject goes through `normalizeUrl` before anything is looked up, because
   * `pages.url_normalized` is what `normalizeUrl` produced: WordPress's canonical form
   * for `/newsletter-signup` carries a trailing slash (measured 2026-08-19, three estate
   * sites 301 to it), and a review keyed on the unslashed string would match nothing for
   * ever.
   */
  it("resolves the subject a person typed to the identity the crawl stored", async () => {
    const site = newSite();
    await crawlOf(site);
    const noted = await noteOrphan(site, "/newsletter-signup", "no trailing slash typed");

    expect(noted.code).toBe(EXIT.ok);
    expect(noted.stdout).toContain(`noted: orphan ${HOST}/newsletter-signup/`);
    expect((await reviewsOf(site)).map((row) => row.subject)).toEqual([
      `${HOST}/newsletter-signup/`,
    ]);
  });

  /**
   * A typo in a URL must not store a review that matches nothing: it would sit in the
   * table for ever while the real finding stayed ranked as new — a failure that printed
   * "noted" (engineering guide §1).
   */
  it("refuses a subject that this crawl did not find, and writes nothing", async () => {
    const site = newSite();
    const crawlId = await crawlOf(site);
    const before = await measured(crawlId);

    const typo = await noteOrphan(site, "/newsletter-signups/", "not a page of the site");
    expect(typo.code).toBe(EXIT.usage);
    expect(typo.stderr).toMatch(/is not one of the 4 orphan finding\(s\)/);
    expect(typo.stdout).toBe("");
    expect(await measured(crawlId)).toBe(before);
    expect(await reviewsOf(site)).toHaveLength(0);
  });

  it("refuses a subject on another host", async () => {
    const site = newSite();
    await crawlOf(site);
    const result = await noteOrphan(site, "https://integrity.com/test/", "wrong site");
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/is not on 403bplan-net/);
  });

  it("refuses both commands on a site with no complete crawl", async () => {
    const site = newSite();
    // A site row with no crawl of its own: `loadFixture` writes both, so this one is
    // written directly — through `upsertSite`, so it carries every registry column
    // rather than a hand-written subset.
    await upsertSite(db.pool, {
      siteId: site,
      canonicalHost: "403bplan.net",
      aliases: ["403bplan.net"],
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

    const report = await run(["report", site]);
    expect(report.code).toBe(EXIT.failed);
    expect(report.stderr).toMatch(/no complete crawl/);
    expect(report.stdout).toBe("");

    const noted = await noteOrphan(site, "/test-pay-button/", "nothing to judge yet");
    expect(noted.code).toBe(EXIT.failed);
    expect(noted.stderr).toMatch(/no complete crawl/);
    expect(noted.stdout).toBe("");
  });

  /**
   * `analyse` throws after `finishCrawl` has already written `complete`, so a crawl with
   * no metrics row is a state real runs produce. `note` must name that rather than
   * report "0 finding(s)" and blame the URL — exit 1 says "nothing is wrong with the
   * estate", which would be false.
   */
  it("refuses to judge a crawl analyse never finished, rather than blaming the URL", async () => {
    const site = newSite();
    const crawlId = await crawlOf(site);
    // The state `analyse` leaves behind when it refuses a crawl: complete, classified
    // by nothing.
    await db.pool.query(`DELETE FROM crawl_metrics WHERE crawl_id = $1`, [crawlId]);
    await db.pool.query(`UPDATE pages SET class = NULL WHERE crawl_id = $1`, [crawlId]);

    const noted = await noteOrphan(site, "/test-pay-button/", "a leftover test page");
    expect(noted.code).toBe(EXIT.failed);
    expect(noted.stderr).toMatch(/has never run over it/);
    expect(noted.stderr).not.toMatch(/0 orphan finding/);
    expect(noted.stdout).toBe("");
    expect(await reviewsOf(site)).toHaveLength(0);
  });

  /**
   * PRD §2's Undetectable, on the write path: the orphan list of a site with no truth
   * source is empty by design and for ever, so "0 orphan finding(s)" would read as "this
   * site has no orphans". Its broken links are still reviewable (PRD §15).
   */
  it("refuses an orphan review on a crawl that could not answer the question", async () => {
    const site = newSite();
    await crawlOf(site, { noTruthSource: true });

    const noted = await noteOrphan(site, "/newsletters/", "looks unlinked");
    expect(noted.code).toBe(EXIT.failed);
    expect(noted.stderr).toMatch(/could not answer the orphan question/);
    expect(noted.stderr).toMatch(/never zero orphans/);
    expect(await reviewsOf(site)).toHaveLength(0);
  });

  /**
   * Rule 5's other half, and the line of `upsertFindingReview` that refreshes the
   * digest: a finding re-judged after its evidence moved has to read `reviewed` again,
   * or the report would print "changed since review" for ever and the second judgement
   * would have bought nothing.
   */
  it("clears 'changed since review' when the finding is judged again", async () => {
    const site = newSite();
    await crawlOf(site, { contactUsBroken: true });
    const note = (message: string) =>
      run([
        "note",
        site,
        "broken_internal_link",
        "/contact-us/",
        "--acknowledged",
        "-m",
        message,
      ]);
    expect((await note("waiting on the redirect")).code).toBe(EXIT.ok);

    // 13 → 14 linking pages: the review is now stale.
    await crawlOf(site, { contactUsBroken: true, includeSearchPage: true });
    expect((await run(["report", site])).stdout).toContain("1 changed since review");

    const again = await note("now on one more page");
    expect(again.code).toBe(EXIT.ok);
    expect(again.stdout).toMatch(/replaced smile's acknowledged review of/);
    const report = await run(["report", site]);
    expect(report.stdout).toContain(
      "Broken links   1 target(s) — 0 new, 0 changed since review, 1 reviewed",
    );
    // The new note, not the old one: the upsert replaced the judgement, not just its
    // digest.
    expect(report.stdout).toContain("now on one more page");
    expect(report.stdout).not.toContain("waiting on the redirect");
  });

  /**
   * A review nobody signed is one nobody can ask about, so an unset `$USER` with no
   * `--by` is a refusal rather than a row saying "unknown". A cron or CI invocation is
   * exactly where `$USER` is missing.
   */
  it("refuses a review with no author rather than storing an anonymous one", async () => {
    const site = newSite();
    await crawlOf(site);
    const errors: string[] = [];
    const io = {
      out: () => undefined,
      err: (line: string) => errors.push(line),
      // No USER, which is the shape of a cron or CI environment.
      env: { DATABASE_URL: db.url },
    };
    const code = await main(
      ["note", site, "orphan", "/newsletters/", "--intentional", "-m", "unsigned"],
      io,
      deps,
    );

    expect(code).toBe(EXIT.usage);
    expect(errors.join("\n")).toMatch(/\$USER is not set/);
    expect(await reviewsOf(site)).toHaveLength(0);
  });

  it("refuses an unknown site by name", async () => {
    const result = await run(["report", "not-a-site"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain("not-a-site");
    expect(result.stdout).toBe("");
  });

  /**
   * PRD §2's Undetectable, through the stored path: the orphan count is unknown, so the
   * report prints the reason in its place and the exit code is 3 — the same code the
   * crawl command returns for it, because a caller reading only the code must not record
   * a coverage gap as an orphan count.
   */
  it("exits 3 and prints the reason when the stored orphan count is unknown", async () => {
    const site = newSite();
    await crawlOf(site, { noTruthSource: true });
    const report = await run(["report", site]);

    expect(report.code).toBe(EXIT.undetectable);
    expect(report.stdout).toContain("Orphans        unknown — no_truth_source:");
    expect(report.stdout).not.toMatch(/Orphans\s+0/);
  });

  /** `--by` overrides `$USER`, and the report says who judged what. */
  it("attributes a review to --by rather than to the process owner", async () => {
    const site = newSite();
    await crawlOf(site);
    const noted = await run([
      "note",
      site,
      "orphan",
      "/newsletters/",
      "--acknowledged",
      "-m",
      "the newsletter archive needs a nav entry",
      "--by",
      "dave",
    ]);
    expect(noted.code).toBe(EXIT.ok);

    const report = await run(["report", site]);
    expect(report.stdout).toContain("acknowledged, judged 0 day(s) ago by dave");
    expect(report.stdout).toContain("1 reviewed (0 intentional, 1 acknowledged)");
  });

  /**
   * Re-judging a finding replaces the judgement and says whose it replaced. A silent
   * overwrite of somebody else's note is a loss that looks like a success.
   */
  it("says whose review it replaced", async () => {
    const site = newSite();
    await crawlOf(site);
    expect((await noteOrphan(site, "/newsletters/", "looks deliberate")).code).toBe(
      EXIT.ok,
    );
    const second = await run([
      "note",
      site,
      "orphan",
      "/newsletters/",
      "--acknowledged",
      "-m",
      "no, it needs a nav entry",
      "--by",
      "dave",
    ]);

    expect(second.code).toBe(EXIT.ok);
    expect(second.stdout).toMatch(/replaced smile's intentional review of/);
    // One row, not two: re-judging replaces the judgement (PRD §7.1 rule 2's key).
    expect(await reviewsOf(site)).toHaveLength(1);
  });
});
