/**
 * `analyse` against real Postgres: one real 13-page site in, the orphan table out.
 *
 * The expected table below is derived by hand from the captures, not from this code.
 * Every row is checkable: 403bplan.net has one header nav (5 links), one footer
 * (7 links) and almost no in-content linking, so "which pages does anything actually
 * link to" is a question a person can answer by reading the markup — which is the whole
 * reason step 4 is built before the crawler.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTempDatabase,
  findCrawlMetrics,
  listLinks,
  listPages,
  loadFixture,
  parseCrawlFixture,
  runMigrations,
  type TempDatabase,
} from "@link-graph/db";
import { analyse } from "./analyse.js";
import {
  build403bplanCrawl,
  HOME_URL,
  SEARCH_URL,
  type FixtureCrawlJson,
} from "./testing/403bplan.js";

let db: TempDatabase;
beforeAll(async () => {
  db = await createTempDatabase("analyse");
  await runMigrations(db.pool);
});
afterAll(async () => {
  await db.drop();
});

const short = (url: string) => url.replace("https://403bplan.net", "") || "/";

async function load(json: FixtureCrawlJson): Promise<number> {
  return (await loadFixture(db.pool, parseCrawlFixture(json))).crawlId;
}

/** `path → class`, which is the shape a person can read and check against the site. */
async function classes(crawlId: number): Promise<Record<string, string | null>> {
  const rows = await listPages(db.pool, crawlId);
  return Object.fromEntries(rows.map((p) => [short(p.urlNormalized), p.class]));
}

async function depths(crawlId: number): Promise<Record<string, number | null>> {
  const rows = await listPages(db.pool, crawlId);
  return Object.fromEntries(rows.map((p) => [short(p.urlNormalized), p.depth]));
}

/**
 * The whole site, hand-derived. `/` is linked because it is the crawl root, and the four
 * orphans are in the sitemap with no `<a href>` anywhere on the site pointing at them.
 *
 * **The three soft orphans are not all the same case, and one of them is a false
 * positive of PRD §2 as written.** `/disclosures/` and `/terms-of-service/` are footer
 * links on all 13 pages and nothing else — soft orphans by any reading. `/contact-us/`
 * has two real in-content links, from the body of `/plan-participant/` and of
 * `/financial-advisor/`, and is still classified `soft_orphan`, because PRD §2's
 * boilerplate rule keys on the `(target, anchor)` pair and both of those links say
 * "Contact Us", the same as the header nav entry that appears on every page. So the pair
 * is site-wide, every edge into the page is boilerplate, and the contextual count is 0 —
 * while PRD §2's own definition of a soft orphan says "No contextual in-content link
 * anywhere". The two clauses disagree on this page. Asserted as the code behaves, which
 * is PRD §2's operational rule, and reported rather than quietly redefined.
 */
const EXPECTED_CLASSES: Record<string, string> = {
  "/": "linked",
  "/contact-us/": "soft_orphan",
  "/disclosures/": "soft_orphan",
  "/financial-advisor/": "linked",
  "/newsletter-signup/": "orphan",
  "/newsletters/": "orphan",
  "/plan-participant/": "linked",
  "/plan-participant/financial-calculators/": "linked",
  "/plan-participant/fund-prospectuses/": "linked",
  "/plan-participant/online-access/": "orphan",
  "/plan-sponsor/": "linked",
  "/terms-of-service/": "soft_orphan",
  "/test-pay-button/": "orphan",
};

describe("analyse over the real 403bplan.net crawl", () => {
  it("classifies all 13 pages, and the classes are the hand-derived ones", async () => {
    const crawlId = await load(build403bplanCrawl());
    const metrics = await analyse(db.pool, crawlId);

    expect(await classes(crawlId)).toEqual(EXPECTED_CLASSES);
    expect(metrics).toEqual({
      crawlId,
      orphans: 4,
      softOrphans: 3,
      linked: 6,
      excluded: 0,
      notInTruthSource: 0,
      undetectable: 0,
      // The four orphans. Nothing else on the site is unreachable from the homepage.
      unreachable: 4,
      // Every internal edge that resolves points at a page that returned 200.
      broken: 0,
      // 17 PDFs under /wp-content/uploads/ that the crawl has no page row for — 12
      // linked from /plan-participant/fund-prospectuses/, 3 from /plan-sponsor/, 2 from
      // /plan-participant/. Unknown, not missing. See 005_analysis.sql on why this
      // counter has to sit beside `broken`.
      internalUnresolved: 17,
      external: 23,
      boilerplateThresholdPct: 60,
    });
    // The row accounts for every page: a classification that silently skipped pages
    // would otherwise look like a clean result.
    expect(
      (metrics.orphans ?? 0) +
        (metrics.softOrphans ?? 0) +
        metrics.linked +
        metrics.excluded +
        metrics.notInTruthSource +
        metrics.undetectable,
    ).toBe(13);
  });

  it("writes one depth over all internal links, and leaves the unreachable pages null", async () => {
    const crawlId = await load(build403bplanCrawl());
    await analyse(db.pool, crawlId);
    expect(await depths(crawlId)).toEqual({
      "/": 0,
      // Everything in the header nav or the footer is one click from the homepage.
      "/contact-us/": 1,
      "/disclosures/": 1,
      "/financial-advisor/": 1,
      "/plan-participant/": 1,
      "/plan-sponsor/": 1,
      "/terms-of-service/": 1,
      // In-content links from /plan-participant/ only.
      "/plan-participant/financial-calculators/": 2,
      "/plan-participant/fund-prospectuses/": 2,
      // The four orphans: no path from the homepage at all.
      "/newsletter-signup/": null,
      "/newsletters/": null,
      "/plan-participant/online-access/": null,
      "/test-pay-button/": null,
    });
  });

  it("marks every edge boilerplate or contextual, and never leaves one unmarked", async () => {
    const crawlId = await load(build403bplanCrawl());
    await analyse(db.pool, crawlId);
    const links = await listLinks(db.pool, crawlId);
    expect(links).toHaveLength(240);
    expect(links.filter((l) => l.isBoilerplate === null)).toHaveLength(0);
    // 12 (target, anchor) pairs appear on all 13 pages, and they account for 184 edges:
    // 4 header-only (13 each) + 5 footer-only (13 each) + 2 in both header and footer
    // (the YouTube and LinkedIn icons, anchor "", 26 each) + (contact-us, "Contact Us"),
    // which is 13 header edges plus the 2 in-content ones. 52 + 65 + 52 + 15 = 184.
    expect(links.filter((l) => l.isBoilerplate === true)).toHaveLength(184);
    // External edges are classified on the same axis (PRD §6) — a footer link to
    // LinkedIn on every page is boilerplate whoever it points at. 91 of them: the two
    // header+footer icon pairs (26 each) and three footer-only pairs (13 each).
    expect(links.filter((l) => l.isExternal && l.isBoilerplate === true)).toHaveLength(
      91,
    );
  });

  it("is idempotent: a second run writes the same classes and the same metrics", async () => {
    const crawlId = await load(build403bplanCrawl());
    const first = await analyse(db.pool, crawlId);
    const firstClasses = await classes(crawlId);
    const second = await analyse(db.pool, crawlId);
    expect(second).toEqual(first);
    expect(await classes(crawlId)).toEqual(firstClasses);
    expect(await findCrawlMetrics(db.pool, crawlId)).toEqual(first);
  });

  it("honours the boilerplate threshold, and records the N it used", async () => {
    const crawlId = await load(build403bplanCrawl());
    // 5% of 13 pages is 0.65, so every (target, anchor) pair on 1 page or more counts
    // as boilerplate — no edge is contextual, and every linked page becomes soft.
    const metrics = await analyse(db.pool, crawlId, { boilerplateThresholdPct: 5 });
    expect(metrics.boilerplateThresholdPct).toBe(5);
    expect(metrics.softOrphans).toBe(8);
    expect(metrics.linked).toBe(1); // the crawl root, and nothing else
    expect(metrics.orphans).toBe(4); // an orphan has no edges to reclassify
  });
});

/**
 * The planted `noindex` page (`testing/403bplan.ts` documents why it has to be planted).
 * Both effects below were predicted before the code ran, and the second one is a real
 * hazard: **a `noindex` search-results page hides a genuine orphan.** PRD §2 defines a
 * true orphan as having "zero inbound internal links found anywhere in the crawl", and
 * by that letter `/plan-participant/online-access/` stops being an orphan the moment a
 * search page linking to it is crawled — even though the search page is itself excluded
 * and unreachable. Reported, not decided.
 */
describe("the planted noindex page", () => {
  it("classifies as excluded, and takes one page out of the orphan set", async () => {
    const crawlId = await load(build403bplanCrawl({ includeSearchPage: true }));
    const metrics = await analyse(db.pool, crawlId);

    expect(await classes(crawlId)).toEqual({
      ...EXPECTED_CLASSES,
      "/?s=403b": "excluded",
      "/plan-participant/online-access/": "linked",
    });
    expect(metrics).toMatchObject({
      orphans: 3,
      softOrphans: 3,
      excluded: 1,
      linked: 7,
      // Excluded outranks "absent from the truth source": the search page is both.
      notInTruthSource: 0,
      // The three orphans, plus the search page, plus the page it rescued — which has
      // an inbound contextual edge and still no path from the homepage.
      unreachable: 5,
    });
    expect((await depths(crawlId))["/plan-participant/online-access/"]).toBeNull();
  });
});

/**
 * Two plants that are single documented edits to the real crawl: one edge removed, one
 * page's class predicted to flip. This is what proves the set difference rather than
 * the fixture — an implementation that returned the same table whatever the edges said
 * would pass the tests above and fail these.
 */
describe("planted anomalies: one edge removed, one class flipped", () => {
  const without = (json: FixtureCrawlJson, from: string, to: string, anchor: string) => {
    const links = json.links.filter(
      (l) => !(l.from === from && l.to === to && l.anchor === anchor),
    );
    expect(links).toHaveLength(json.links.length - 1);
    return { ...json, links };
  };

  it("turns a linked page into a true orphan when its only inbound edge goes", async () => {
    // /plan-participant/fund-prospectuses/ is linked from exactly one place on the
    // site: "View Prospectus", in the content of /plan-participant/.
    const crawlId = await load(
      without(
        build403bplanCrawl(),
        "https://403bplan.net/plan-participant/",
        "https://403bplan.net/plan-participant/fund-prospectuses/",
        "View Prospectus",
      ),
    );
    const metrics = await analyse(db.pool, crawlId);
    expect((await classes(crawlId))["/plan-participant/fund-prospectuses/"]).toBe(
      "orphan",
    );
    expect((await depths(crawlId))["/plan-participant/fund-prospectuses/"]).toBeNull();
    expect(metrics).toMatchObject({
      orphans: 5,
      softOrphans: 3,
      linked: 5,
      unreachable: 5,
    });
  });

  /**
   * A self-link cannot bring a visitor to a page, so it is not an inbound link for the
   * purpose of the orphan question — and counting it would hide an orphan behind its own
   * nav entry. The plant is the strongest form of this: an orphan whose ONLY inbound
   * edge is its own.
   */
  it("keeps a page an orphan when its only inbound edge is a link to itself", async () => {
    const json = build403bplanCrawl();
    const crawlId = await load({
      ...json,
      links: [
        ...json.links,
        {
          from: "https://403bplan.net/newsletters/",
          to: "https://403bplan.net/newsletters/",
          anchor: "Back to newsletters",
          rel: null,
          container: "main",
          domIndex: 999,
        },
      ],
    });
    const metrics = await analyse(db.pool, crawlId);
    expect((await classes(crawlId))["/newsletters/"]).toBe("orphan");
    expect(metrics).toMatchObject({ orphans: 4, softOrphans: 3, linked: 6 });
  });

  /**
   * The counter that keeps `broken = 0` honest has three buckets to cover, not two, and
   * the middle one was missing: an internal edge can point at a page row that exists and
   * was never fetched. `/contact-us/` is in the header nav of all 13 pages, so making it
   * unfetched puts 13 edges into that bucket — and before this was fixed the metrics row
   * came back byte-identical to the healthy crawl's.
   */
  it("counts an internal edge to a page of unknown status as unresolved, never as fine", async () => {
    const json = build403bplanCrawl();
    const crawlId = await load({
      ...json,
      pages: json.pages.map((p) =>
        p.url === "https://403bplan.net/contact-us/" ? { ...p, statusCode: null } : p,
      ),
    });
    const metrics = await analyse(db.pool, crawlId);
    // 17 PDFs with no page row at all, plus all 15 edges into the unfetched page: 13
    // header (its own self-link included) and the 2 in-content ones.
    expect(metrics.internalUnresolved).toBe(17 + 15);
    expect(metrics.broken).toBe(0);
  });

  it("turns a linked page into a soft orphan when its only contextual edge goes", async () => {
    // /financial-advisor/ has 13 header nav edges (boilerplate) and one in-content
    // "Learn More" from the homepage. Remove that one and the nav is all that is left.
    const crawlId = await load(
      without(
        build403bplanCrawl(),
        HOME_URL,
        "https://403bplan.net/financial-advisor/",
        "Learn More",
      ),
    );
    const metrics = await analyse(db.pool, crawlId);
    expect((await classes(crawlId))["/financial-advisor/"]).toBe("soft_orphan");
    // Still one click from the homepage: the nav edge is an edge.
    expect((await depths(crawlId))["/financial-advisor/"]).toBe(1);
    expect(metrics).toMatchObject({ orphans: 4, softOrphans: 4, linked: 5 });
  });
});

/** Engineering guide §1: every one of these must be loud rather than a plausible zero. */
describe("refusals", () => {
  it("refuses to produce metrics for a partial crawl", async () => {
    const json = build403bplanCrawl();
    const crawlId = await load({ ...json, crawl: { ...json.crawl, status: "partial" } });
    await expect(analyse(db.pool, crawlId)).rejects.toThrow(/partial/);
    // and nothing was written
    expect(await findCrawlMetrics(db.pool, crawlId)).toBeNull();
    expect(Object.values(await classes(crawlId)).every((c) => c === null)).toBe(true);
  });

  it("refuses a crawl in which no page was ever fetched", async () => {
    const json = build403bplanCrawl();
    const crawlId = await load({
      ...json,
      pages: json.pages.map((p) => ({ ...p, statusCode: null })),
    });
    await expect(analyse(db.pool, crawlId)).rejects.toThrow(/fetched/);
    expect(await findCrawlMetrics(db.pool, crawlId)).toBeNull();
  });

  /**
   * Found by reviewing the diff, not by a failing test: the first version of this
   * refusal checked that the homepage ROW existed, and a crawl whose homepage fetch
   * failed — a Wordfence 403, a timeout — sailed through it. Measured on this fixture at
   * the time: 4 orphans, 6 soft orphans, 12 of 13 pages unreachable, no error, and the
   * homepage itself reported `linked`.
   */
  it("refuses a crawl whose homepage was never fetched", async () => {
    const json = build403bplanCrawl();
    const crawlId = await load({
      ...json,
      pages: json.pages.map((p) => (p.url === HOME_URL ? { ...p, statusCode: null } : p)),
      links: json.links.filter((l) => l.from !== HOME_URL),
    });
    await expect(analyse(db.pool, crawlId)).rejects.toThrow(/never fetched/);
    expect(await findCrawlMetrics(db.pool, crawlId)).toBeNull();
  });

  it("refuses a crawl whose homepage did not serve", async () => {
    const json = build403bplanCrawl();
    const crawlId = await load({
      ...json,
      pages: json.pages.map((p) => (p.url === HOME_URL ? { ...p, statusCode: 503 } : p)),
    });
    await expect(analyse(db.pool, crawlId)).rejects.toThrow(/returned 503/);
    expect(await findCrawlMetrics(db.pool, crawlId)).toBeNull();
  });

  /**
   * Engineering guide §1: an empty result is a loud error, never an answer. Without this
   * refusal a link-extraction failure publishes "12 of 13 pages are orphans" as fact.
   */
  it("refuses a crawl that fetched pages and extracted no links", async () => {
    const crawlId = await load({ ...build403bplanCrawl(), links: [] });
    await expect(analyse(db.pool, crawlId)).rejects.toThrow(/no links at all/);
    expect(await findCrawlMetrics(db.pool, crawlId)).toBeNull();
    // This refusal fires after the classes and depths have been written, so it is also
    // the proof that the whole pass is one transaction: a half-analysed crawl in the
    // tables reads exactly like a small clean site.
    expect(Object.values(await classes(crawlId)).every((c) => c === null)).toBe(true);
    expect(Object.values(await depths(crawlId)).every((d) => d === null)).toBe(true);
  });

  it("refuses a threshold outside (0, 100]", async () => {
    const crawlId = await load(build403bplanCrawl());
    for (const pct of [0, 101, Number.NaN]) {
      await expect(
        analyse(db.pool, crawlId, { boilerplateThresholdPct: pct }),
      ).rejects.toThrow(/\(0, 100\]/);
    }
    expect(await findCrawlMetrics(db.pool, crawlId)).toBeNull();
  });

  it("refuses a crawl with no homepage row rather than calling every page unreachable", async () => {
    const json = build403bplanCrawl();
    const crawlId = await load({
      ...json,
      pages: json.pages.filter((p) => p.url !== HOME_URL),
      links: json.links.filter((l) => l.from !== HOME_URL),
    });
    await expect(analyse(db.pool, crawlId)).rejects.toThrow(/403bplan\.net/);
    expect(await findCrawlMetrics(db.pool, crawlId)).toBeNull();
  });

  it("refuses an unknown crawl id", async () => {
    await expect(analyse(db.pool, 987654)).rejects.toThrow(/987654/);
  });
});

/**
 * PRD §2, Undetectable: no truth source means no inventory to difference against. The
 * orphan counters must be null, not zero — "0 orphans" for a site nobody can check
 * reads as good news, which engineering guide §1 opens by forbidding.
 */
describe("a site with no truth source", () => {
  it("reports undetectable coverage and null orphan counts", async () => {
    const json = build403bplanCrawl({ includeSearchPage: true });
    const crawlId = await load({
      ...json,
      site: { ...json.site, siteId: "403bplan-net-no-truth", truthSource: "none" },
      pages: json.pages.map((p) => ({ ...p, inTruthSource: false })),
    });
    const metrics = await analyse(db.pool, crawlId);
    expect(metrics).toMatchObject({
      orphans: null,
      softOrphans: null,
      // The noindex page is still excluded: that fact does not need an inventory.
      excluded: 1,
      undetectable: 12,
      notInTruthSource: 0,
      // The crawl root, which is reachable in zero clicks whether or not an inventory
      // exists — the one page whose orphan status needs no truth source.
      linked: 1,
    });
    expect(new Set(Object.values(await classes(crawlId)))).toEqual(
      new Set(["undetectable", "excluded", "linked"]),
    );
    expect((await classes(crawlId))[short(SEARCH_URL)]).toBe("excluded");
  });
});
