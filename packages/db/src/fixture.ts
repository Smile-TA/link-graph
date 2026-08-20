/**
 * `loadFixture` — a recorded crawl as JSON, written into `crawls` / `pages` / `links`.
 *
 * **Why this exists.** Engineering guide §4.3 requires every service to have a test
 * entry point that runs without any other service: the analyser (step 4) and the API
 * (step 11) must both be testable with no crawler present. Seeding Postgres from a
 * fixture is the only thing that makes that true, which is why this ships with the
 * schema rather than being bolted onto a test later.
 *
 * **Why the JSON looks like this.** It is a contract two later steps depend on, so
 * each shape decision has a reason:
 *
 * - **Links name their endpoints by URL, not by row id.** Ids are assigned by the
 *   database, so a hand-written fixture cannot know them, and a generated one that
 *   did would be unreadable. `from` must name a page in the same fixture; `to` need
 *   not, because a link to a page the crawl never fetched is a real and important
 *   case (that is what `to_page_id IS NULL` means).
 * - **`path` and `isExternal` are derived, never written.** Both are functions of the
 *   URL and the site's alias set. Accepting them would allow a fixture in which
 *   `path` disagrees with `url` — two sources of truth for one fact, which §2 calls
 *   a bug rather than flexibility.
 * - **Every URL must already be normalized, and this is checked.** A fixture whose
 *   pages say `/about` while the crawler would store `/about/` plants a fake orphan,
 *   and step 4 would then "prove" its maths against a wrong answer. So each URL is
 *   run through `normalizeUrl` and must come back unchanged.
 * - **`depth`, `class` and `isBoilerplate` are optional and default to null**, not to
 *   a value. They are analyse's output; a default would make an unanalysed crawl look
 *   analysed, which engineering guide §1 forbids.
 * - **`inTruthSource`, `indexable` and the crawl's `status` are required.** These are
 *   exactly the inputs the orphan definition turns on (PRD §2). Defaulting
 *   `indexable` to true manufactures orphans; defaulting `status` to `complete`
 *   is the pw-template bug the guide opens with.
 * - **Unknown keys are rejected.** A typo in an optional field would otherwise land
 *   as null and change the answer silently.
 * - **It can carry what `extractPage` actually produces.** `anchor`, `rel`,
 *   `container` and `domIndex` are its `RawLink` fields; `indexable` is
 *   `!head.noindex` and `canonicalTo` is `head.canonical`. `fixture.test.ts` builds
 *   a fixture straight out of `extractPage` over the checked-in captures to keep that
 *   true. Head signals with no column — `title`, the raw `robots` list — are not
 *   accepted, because PRD §11 puts title and meta analysis out of scope.
 *
 * Everything above the database write is pure and unit-tested (`parseCrawlFixture`),
 * so the shape of the contract is checked with no Postgres running.
 */
import { readFile } from "node:fs/promises";
import { normalizeUrl, type LinkContainer, type SiteHosts } from "@link-graph/core";
import type { Pool } from "pg";
import { Fields, fail, object } from "./json-fields.js";
import { withTransaction } from "./pool.js";
import {
  upsertSite,
  CRAWLER_MODES,
  TRUTH_SOURCES,
  type SiteInput,
} from "./repo/sites.js";
import {
  insertCrawl,
  CRAWL_ENVS,
  CRAWL_STATUSES,
  type CrawlEnv,
  type CrawlStatus,
} from "./repo/crawls.js";
import { insertPages, type PageInput } from "./repo/pages.js";
import { insertLinks, type LinkInput } from "./repo/links.js";

/**
 * The container vocabulary as a runtime value. `core` exports `LinkContainer` as a
 * type only, so this is the one place in TypeScript that repeats the seven values;
 * the `satisfies` makes an eighth container added in `core` a compile error here,
 * rather than a fixture carrying valid `extractPage` output being rejected at run
 * time. The third copy is the CHECK constraint in `002_crawls.sql`.
 */
const CONTAINERS = Object.keys({
  header: true,
  footer: true,
  nav: true,
  aside: true,
  main: true,
  article: true,
  body: true,
} satisfies Record<LinkContainer, true>) as LinkContainer[];

/** A link with its endpoints still named by URL, as the JSON names them. */
export interface FixtureLink extends Omit<LinkInput, "fromPageId" | "toPageId"> {
  readonly fromUrl: string;
}

export interface FixtureCrawl {
  readonly env: CrawlEnv;
  readonly status: CrawlStatus;
  /** `null` means "use the clock injected into `loadFixture`". */
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly deployedTag: string | null;
  readonly registrySha: string | null;
  readonly wasThrottled: boolean;
}

/** A validated fixture: every URL normalized, every derived field filled in. */
export interface CrawlFixture {
  readonly site: SiteInput;
  readonly crawl: FixtureCrawl;
  readonly pages: readonly PageInput[];
  readonly links: readonly FixtureLink[];
}

export interface LoadedFixture {
  readonly siteId: number;
  readonly crawlId: number;
  readonly pages: number;
  readonly links: number;
}

export interface LoadFixtureDeps {
  /** Injected so a fixture with no timestamps still loads deterministically. */
  readonly now: () => Date;
}

/**
 * A URL a fixture may use as node identity: absolute, and already in the form
 * `normalizeUrl` would produce. See the note on normalization in the module comment.
 */
function normalized(url: string, site: SiteHosts, key: string, where: string) {
  const result = normalizeUrl(url, site);
  if (result === null) {
    fail(where, `${key} is not a crawlable URL: ${url}`);
  }
  if (result.href !== url) {
    fail(
      where,
      `${key} is not normalized: ${url} normalizes to ${result.href}. ` +
        `A fixture must store the identity the crawler would store, or every count ` +
        `derived from it is wrong.`,
    );
  }
  return result;
}

// --- the parser -------------------------------------------------------------------

/**
 * Validate a parsed JSON crawl and fill in its derived fields. Pure: no I/O, so the
 * whole contract is unit-testable with no database.
 *
 * Throws on anything it cannot represent faithfully. That is the point — the
 * alternative is a fixture that loads and quietly means something else.
 */
export function parseCrawlFixture(json: unknown): CrawlFixture {
  const root = new Fields(object(json, "root"), "root");
  const site = parseSite(root.obj("site"));
  const hosts: SiteHosts = { canonicalHost: site.canonicalHost, aliases: site.aliases };
  const crawl = parseCrawl(root.obj("crawl"));
  const pages = parsePages(root.array("pages"), hosts);
  const links = parseLinks(root.array("links"), hosts, pages);
  root.done();
  return { site, crawl, pages, links };
}

function parseSite(raw: Record<string, unknown>): SiteInput {
  const f = new Fields(raw, "site");
  const canonicalHost = hostname(f.str("canonicalHost"), "canonicalHost");
  const aliases = (f.optStrArray("aliases") ?? []).map((a, i) =>
    hostname(a, `aliases[${i}]`),
  );
  // normalizeUrl resolves internal/external against the alias set, so a canonical
  // host missing from it would make the site's own pages external to themselves.
  if (!aliases.includes(canonicalHost)) {
    fail("site", `aliases must include canonicalHost ${canonicalHost}`);
  }
  const site: SiteInput = {
    siteId: f.str("siteId"),
    canonicalHost,
    aliases,
    stageHost: f.optStr("stageHost"),
    enabled: f.optBool("enabled") ?? true,
    // Required: 'none' means "no truth source, so orphans are undetectable" and null
    // means "not resolved yet". A fixture that left it out would be claiming the
    // second while meaning the first (PRD §2, Undetectable).
    truthSource: f.oneOf("truthSource", TRUTH_SOURCES),
    crawlerMode: f.optOneOf("crawlerMode", CRAWLER_MODES, "http"),
    rateLimit: f.optNumber("rateLimit") ?? 1,
    ignorePaths: f.optStrArray("ignorePaths") ?? [],
  };
  f.done();
  return site;
}

function parseCrawl(raw: Record<string, unknown>): FixtureCrawl {
  const f = new Fields(raw, "crawl");
  const crawl: FixtureCrawl = {
    // Phase 1 is prod-only (PRD §8), so 'prod' is a decision already made rather
    // than a default that hides one.
    env: f.optOneOf("env", CRAWL_ENVS, "prod"),
    status: f.oneOf("status", CRAWL_STATUSES),
    startedAt: f.optDate("startedAt"),
    finishedAt: f.optDate("finishedAt"),
    deployedTag: f.optStr("deployedTag"),
    registrySha: f.optStr("registrySha"),
    wasThrottled: f.optBool("wasThrottled") ?? false,
  };
  f.done();
  return crawl;
}

/**
 * A bare hostname: no scheme, no port, no path, no trailing dot. The alias set is
 * what decides internal versus external for every edge, so one stray character in it
 * (`"www.lionstreet.com/"`) turns a whole class of real links into phantom external
 * nodes — the failure 001_sites.sql exists to prevent — with nothing else to notice.
 */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function hostname(value: string, key: string): string {
  const host = value.toLowerCase();
  if (!HOSTNAME.test(host)) {
    fail("site", `${key} must be a bare hostname, got ${JSON.stringify(value)}`);
  }
  return host;
}

function optNormalized(
  url: string | null,
  hosts: SiteHosts,
  key: string,
  where: string,
): string | null {
  return url === null ? null : normalized(url, hosts, key, where).href;
}

function parsePages(raw: unknown[], hosts: SiteHosts): PageInput[] {
  // A crawl with no pages is a crawl that fetched nothing, and every number derived
  // from it — "0 orphans" loudest of all — would read as good news (guide §1).
  if (raw.length === 0) fail("pages", "a fixture must contain at least one page");
  const pages: PageInput[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const where = `pages[${i}]`;
    const f = new Fields(object(entry, where), where);
    const url = normalized(f.str("url"), hosts, "url", where);
    if (!url.isInternal) {
      fail(
        where,
        `url is not on this site: ${url.href} (aliases: ${hosts.aliases.join(", ")})`,
      );
    }
    if (seen.has(url.href)) fail(where, `duplicate url ${url.href}`);
    seen.add(url.href);
    const page: PageInput = {
      urlNormalized: url.href,
      path: url.path,
      postType: f.optStr("postType"),
      statusCode: f.optInt("statusCode"),
      depth: f.optInt("depth"),
      inTruthSource: f.bool("inTruthSource"),
      indexable: f.bool("indexable"),
      // Normalized like any other URL, and for the same reason: step 4 joins
      // canonical_to back against pages.url_normalized to find the canonicalized
      // duplicates of PRD §2, and `/about` would never match `/about/`. Both may
      // point off-site, so neither is required to be internal.
      canonicalTo: optNormalized(f.optStr("canonicalTo"), hosts, "canonicalTo", where),
      redirectTo: optNormalized(f.optStr("redirectTo"), hosts, "redirectTo", where),
      class: f.optStr("class"),
    };
    f.done();
    pages.push(page);
  });
  return pages;
}

function parseLinks(
  raw: unknown[],
  hosts: SiteHosts,
  pages: readonly PageInput[],
): FixtureLink[] {
  const pageUrls = new Set(pages.map((p) => p.urlNormalized));
  // domIndex defaults to the link's position among its own page's links, matching
  // extractPage's "position in the page's <a href> sequence". The unique constraint
  // on (crawl_id, from_page_id, dom_index) turns any collision with an explicitly
  // given index into an error rather than a lost edge.
  const nextIndex = new Map<string, number>();
  return raw.map((entry, i) => {
    const where = `links[${i}]`;
    const f = new Fields(object(entry, where), where);
    const fromUrl = f.str("from");
    if (!pageUrls.has(fromUrl)) {
      fail(where, `from names no page in this fixture: ${fromUrl}`);
    }
    const to = normalized(f.str("to"), hosts, "to", where);
    const ordinal = nextIndex.get(fromUrl) ?? 0;
    nextIndex.set(fromUrl, ordinal + 1);
    const link: FixtureLink = {
      fromUrl,
      toUrlNormalized: to.href,
      anchor: f.str("anchor"),
      rel: f.optStr("rel"),
      isExternal: !to.isInternal,
      isBoilerplate: f.optBool("isBoilerplate"),
      container: f.oneOf("container", CONTAINERS),
      domIndex: f.optInt("domIndex") ?? ordinal,
    };
    f.done();
    return link;
  });
}

/**
 * Write a validated fixture as one crawl. All of it or none of it: a half-loaded
 * fixture is a small site that looks complete.
 */
export async function loadFixture(
  pool: Pool,
  fixture: CrawlFixture,
  deps: LoadFixtureDeps = { now: () => new Date() },
): Promise<LoadedFixture> {
  return withTransaction(pool, async (tx) => {
    const site = await upsertSite(tx, fixture.site);
    const crawl = await insertCrawl(tx, {
      siteId: site.id,
      env: fixture.crawl.env,
      startedAt: fixture.crawl.startedAt ?? deps.now(),
      finishedAt: fixture.crawl.finishedAt,
      status: fixture.crawl.status,
      deployedTag: fixture.crawl.deployedTag,
      registrySha: fixture.crawl.registrySha,
      // The fixture is the record of what the crawl saw, so its page count is
      // pages_seen; accepting a separate number would let the two disagree.
      pagesSeen: fixture.pages.length,
      wasThrottled: fixture.crawl.wasThrottled,
    });

    const inserted = await insertPages(tx, crawl.id, fixture.pages);
    const idByUrl = new Map(inserted.map((p) => [p.urlNormalized, p.id]));

    const links: LinkInput[] = fixture.links.map((link) => {
      const fromPageId = idByUrl.get(link.fromUrl);
      if (fromPageId === undefined) {
        // parseCrawlFixture already proved every `from` names a page, so reaching
        // here would mean insertPages lost one — which it now refuses to do quietly.
        throw new Error(`loadFixture: no page row for ${link.fromUrl}`);
      }
      return {
        fromPageId,
        // A target the crawl has no page for stays as a URL with a null page id:
        // that is exactly how a link to an uncrawled or external page is recorded.
        toPageId: idByUrl.get(link.toUrlNormalized) ?? null,
        toUrlNormalized: link.toUrlNormalized,
        anchor: link.anchor,
        rel: link.rel,
        isExternal: link.isExternal,
        isBoilerplate: link.isBoilerplate,
        container: link.container,
        domIndex: link.domIndex,
      };
    });

    return {
      siteId: site.id,
      crawlId: crawl.id,
      pages: inserted.length,
      links: await insertLinks(tx, crawl.id, links),
    };
  });
}

/**
 * Read a JSON crawl from disk and load it. The two steps stay separate so that a
 * malformed fixture fails with the file name attached, and so `parseCrawlFixture`
 * remains testable with no filesystem and no database.
 */
export async function loadFixtureFile(pool: Pool, path: string): Promise<LoadedFixture> {
  const text = await readFile(path, "utf8");
  let fixture: CrawlFixture;
  try {
    fixture = parseCrawlFixture(JSON.parse(text));
  } catch (error) {
    throw new Error(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return loadFixture(pool, fixture);
}
