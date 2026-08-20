/**
 * `resolveTruthSource(site, deps) → { kind, urls, postTypes }` — the CMS side of the
 * orphan set difference (PRD §4).
 *
 * Orphan detection is a set difference against a known inventory, so this is the only
 * component that can make it possible at all — and the only one that can make it
 * silently wrong. Every refusal below exists because the alternative is an inventory
 * that is smaller than the site, and a smaller inventory reports fewer orphans:
 * engineering guide §1's failure that reads as good news, in the one place where the
 * number nobody can check is the denominator.
 *
 * **Cross-check, not fallback.** PRD §4 resolves REST first and the sitemap second, and
 * PRD §13 requires the two counts compared. Both sources are therefore always read, the
 * inventory is their union, and `kind` records which one the resolution order preferred.
 * See `inventory.ts` for the 28 published pages on integrity.com that only one of them
 * knows about.
 */
import type { SiteHosts } from "@link-graph/core";
import { normalizeUrl } from "@link-graph/core";
import type { HttpResult, TruthDeps } from "./http.js";
import {
  collectionUrl,
  contentPostTypes,
  parseCollectionPage,
  parsePostTypes,
  skipReason,
  PER_PAGE,
  type RestPostType,
} from "./rest.js";
import {
  gather,
  mergeInventories,
  restMissing,
  sitemapInvisible,
  type FoundUrl,
  type TruthCounts,
  type TruthUrl,
} from "./inventory.js";
import { readSitemapResponse, SITEMAP_CANDIDATES } from "./sitemap.js";

/**
 * `unreachable` is the fourth value, and PRD §3 lists three.
 *
 * These are exactly `TRUTH_SOURCES` in `@link-graph/db`, and deliberately not imported
 * from it: this package depends on `core` alone (implementation plan, step 5), and the
 * two vocabularies meet where a resolution is written to `sites.truth_source` — the
 * assignment TypeScript checks. A value added here and not there is a compile error at
 * that seam rather than a constraint violation at INSERT.
 *
 * `none` means "we asked and this site has no inventory": orphan detection is
 * impossible and the remedy is a content decision. A host that never answers has told
 * us nothing at all — `agents.integrity.com` has no DNS and
 * `integritymedicarehelpline.com` refuses connections (PRD §3.1), and both still hold
 * live pw-template configs. Recording those as `none` files a broken deployment as a
 * permanently unmonitorable site; recording them as NULL claims we never looked. Both
 * are wrong in a way nobody would notice, so the column gained a value (006).
 */
export type TruthSourceKind = "rest" | "sitemap" | "none" | "unreachable";

/**
 * A degradation that must travel with the result. Anything this package drops, could
 * not read, or found the two sources disagreeing about is one of these — never a
 * silently smaller number.
 */
export const TRUTH_FINDING_KINDS = [
  /** REST answered but cannot be an inventory: blocked or malformed. */
  "rest-unusable",
  /**
   * REST answered, and every post type was empty. Not a failure to read it — a site
   * with nothing published — so it falls through to the sitemap and does NOT stop the
   * resolution from concluding there is no truth source.
   */
  "rest-empty",
  /** Enumeration began and could not finish, so REST is not usable as the source. */
  "rest-incomplete",
  /** `X-WP-Total` and the number of URLs pagination actually yielded disagree. */
  "rest-total-mismatch",
  /** A sitemap was used despite a non-2xx status, or a redirect was followed. */
  "sitemap-degraded",
  /** A child sitemap could not be read, so the sitemap is not a complete inventory. */
  "sitemap-incomplete",
  /** In WP REST and absent from the sitemap (PRD §2). */
  "sitemap-invisible",
  /** In the sitemap and absent from WP REST (PRD §4: the disagreement runs both ways). */
  "rest-missing",
  /** A listed URL was dropped: not on this site, or not a crawlable page at all. */
  "dropped-url",
  /** A URL listed more than once by one source. */
  "duplicate-url",
] as const;
export type TruthFindingKind = (typeof TRUTH_FINDING_KINDS)[number];

export interface TruthFinding {
  readonly kind: TruthFindingKind;
  readonly detail: string;
}

export interface PostTypeInventory {
  readonly slug: string;
  readonly restBase: string;
  /** URLs this post type contributed. */
  readonly urls: number;
  /** `X-WP-Total` for the type, or null when it was not enumerated. */
  readonly declaredTotal: number | null;
  /** Why it was not enumerated (`rest.ts`'s `skipReason`), or null if it was. */
  readonly skipped: string | null;
}

export interface TruthSourceResult {
  readonly kind: TruthSourceKind;
  /** The inventory: the union of both sources, each URL carrying its provenance. */
  readonly urls: readonly TruthUrl[];
  /** Empty unless REST's type list was readable. */
  readonly postTypes: readonly PostTypeInventory[];
  readonly counts: TruthCounts;
  readonly findings: readonly TruthFinding[];
  readonly requests: number;
}

export interface TruthSite extends SiteHosts {
  /** The registry slug, for error messages. */
  readonly siteId: string;
}

export interface ResolveOptions {
  /**
   * Hard ceiling on HTTP requests for one site. Exceeding it is an error, never a
   * truncated inventory.
   *
   * Default 1,000. Measured: `agent.familyfirstlife.com` holds 59,362 pages in one post
   * type, which is 594 requests at WordPress's maximum `per_page=100`, and its sitemap
   * is 31. So the largest site in the estate needs ~625 and 1,000 leaves room, while
   * still bounding a site that answers `X-WP-TotalPages: 1000000`.
   */
  readonly maxRequests?: number;
}

const DEFAULT_MAX_REQUESTS = 1000;

interface Enumeration {
  /** `ok` is the only outcome whose `urls` may be used; the rest carry none. */
  readonly kind: "ok" | "absent" | "incomplete" | "unreachable";
  readonly urls: readonly { url: string; postType: string | null }[];
  readonly findings: readonly TruthFinding[];
  readonly requests: number;
}

export interface RestEnumeration extends Enumeration {
  readonly postTypes: readonly PostTypeInventory[];
}

/**
 * Enumerate the given post types, paginating each. Returns `incomplete` rather than a
 * prefix: a collection that stops halfway looks exactly like a smaller site.
 */
export async function enumerateRest(
  site: TruthSite,
  types: readonly RestPostType[],
  deps: TruthDeps,
  maxRequests: number,
): Promise<RestEnumeration> {
  const urls: { url: string; postType: string }[] = [];
  const postTypes: PostTypeInventory[] = [];
  const findings: TruthFinding[] = [];
  let requests = 0;
  const stop = (kind: "incomplete" | "unreachable", finding: TruthFinding) => ({
    kind,
    urls: [],
    postTypes: [],
    findings: [...findings, finding],
    requests,
  });

  for (const type of types) {
    let declaredTotal: number | null = null;
    let declaredPages: number | null = null;
    let collected = 0;
    for (let page = 1; ; page += 1) {
      if (requests >= maxRequests) {
        return stop("incomplete", {
          kind: "rest-incomplete",
          detail:
            `${type.slug}: this enumeration's share of the request budget ` +
            `(${maxRequests}) was exhausted at page ${page}. A prefix of a post type ` +
            `is not an inventory.`,
        });
      }
      const response = await deps.get(collectionUrl(site.canonicalHost, type, page));
      requests += 1;
      if (response.kind === "transport-error") {
        // The first request of the whole enumeration failing means the host stopped
        // answering; a later one means we hold a prefix. Neither is an inventory.
        return stop(requests === 1 ? "unreachable" : "incomplete", {
          kind: "rest-incomplete",
          detail: `${type.slug} page ${page}: ${response.detail}`,
        });
      }
      let parsed;
      try {
        parsed = parseCollectionPage(response);
      } catch (error) {
        return stop("incomplete", {
          kind: "rest-incomplete",
          detail: `${type.slug} page ${page}: ${message(error)}`,
        });
      }
      if (page === 1) {
        declaredTotal = parsed.declaredTotal;
        declaredPages = parsed.declaredPages;
      }
      for (const item of parsed.items) {
        urls.push({ url: item.link, postType: type.slug });
      }
      collected += parsed.items.length;
      if (!parsed.hasNext) {
        // The server's own totals are the only check on pagination having ended for the
        // right reason. Measured: the last page is signalled by the ABSENCE of a
        // `Link: rel="next"` header, and every one of these hosts is behind CloudFront —
        // so an intermediary that drops that header ends the enumeration at page 1 with
        // a 200 and no error. `X-WP-Total` and `X-WP-TotalPages` catch it.
        //
        // **A disagreement makes REST unusable, not merely noteworthy.** This was
        // written the other way first — record the finding, return the short list as
        // `ok` — and Gate 2 found what that costs: the short count becomes
        // `crawls.truth_source_urls`, so `analyse` divides 124 fetched pages by a
        // 124-URL inventory, reports 100% coverage, and publishes the orphan set of a
        // 476-page post type as complete. The finding travels either way; what changes
        // is that the number nobody can check is no longer trusted.
        const shortfall = paginationShortfall(
          type.slug,
          declaredTotal,
          declaredPages,
          collected,
          page,
        );
        if (shortfall !== null) {
          return stop("incomplete", { kind: "rest-total-mismatch", detail: shortfall });
        }
        postTypes.push({
          slug: type.slug,
          restBase: type.restBase,
          urls: collected,
          declaredTotal,
          skipped: null,
        });
        break;
      }
    }
  }

  if (urls.length === 0) {
    // pw-template already encodes this and the guide opens with it: a 200 carrying an
    // empty array is a failure, not an answer, and falls through to the next source.
    return {
      kind: "absent",
      urls: [],
      postTypes: [],
      findings: [
        ...findings,
        {
          kind: "rest-empty",
          detail: `every one of ${types.length} post type(s) returned no URLs`,
        },
      ],
      requests,
    };
  }
  return { kind: "ok", urls, postTypes, findings, requests };
}

/**
 * Why an enumeration that ran out of pages is not to be trusted, or `null` if it is.
 * Both headers are checked because either can be missing: `X-WP-Total` pins the item
 * count, `X-WP-TotalPages` pins how many requests it should have taken.
 *
 * Exported because it is a rule rather than wiring, and the interesting inputs — a
 * header that disagrees in either direction, a header that is missing, both missing —
 * are numbers rather than recorded responses (engineering guide §4.1).
 */
export function paginationShortfall(
  slug: string,
  declaredTotal: number | null,
  declaredPages: number | null,
  collected: number,
  pages: number,
): string | null {
  const evidence = `after ${pages} request(s), ${collected} URL(s) collected`;
  // Only the under-collecting direction. Collecting MORE than the header declared is a
  // superset of the inventory — an item published while pagination ran, which on the
  // 594-request enumeration of agent.familyfirstlife.com is ordinary — and a superset
  // cannot hide an orphan. Refusing it would make the largest site in the estate
  // unresolvable whenever somebody published a page.
  if (declaredTotal !== null && collected < declaredTotal) {
    return `${slug}: X-WP-Total declared ${declaredTotal} but ${evidence}`;
  }
  if (declaredPages !== null && declaredPages > pages) {
    return `${slug}: X-WP-TotalPages declared ${declaredPages} but ${evidence}`;
  }
  // Neither header survived, so nothing corroborates the end of the collection except
  // the absent `rel="next"` — and a full page of items with no continuation signal at
  // all is the shape of a stripped header, not of a collection that ends exactly on the
  // page boundary. Refusing costs a resolution; accepting silently truncates the
  // inventory, which is the failure this whole file exists to prevent.
  if (
    declaredTotal === null &&
    declaredPages === null &&
    collected === pages * PER_PAGE
  ) {
    return (
      `${slug}: neither X-WP-Total nor X-WP-TotalPages was returned and ${evidence}, ` +
      `exactly filling every page — nothing corroborates that the collection ended`
    );
  }
  return null;
}

/**
 * Find the sitemap and follow it to every child. PRD §4: index sitemaps nest and the
 * children must be followed — measured on `agent.familyfirstlife.com`, whose index lists
 * **30** children of 2,000 URLs each. `census.json` records one of them and calls the
 * site 2,000 URLs; it holds 59,362.
 */
export async function enumerateSitemap(
  site: TruthSite,
  deps: TruthDeps,
  maxRequests: number,
): Promise<Enumeration> {
  const findings: TruthFinding[] = [];
  const locs: string[] = [];
  const seen = new Set<string>();
  let requests = 0;
  const incomplete = (detail: string): Enumeration => ({
    kind: "incomplete",
    urls: [],
    findings: [...findings, { kind: "sitemap-incomplete", detail }],
    requests,
  });

  /** One sitemap URL, following at most one redirect. */
  const fetchDoc = async (url: string) => {
    for (let hop = 0; hop < 2; hop += 1) {
      if (requests >= maxRequests) {
        return {
          kind: "error" as const,
          detail: `this enumeration's share of the request budget (${maxRequests}) was exhausted`,
        };
      }
      const response = await deps.get(url);
      requests += 1;
      if (response.kind === "transport-error") {
        return { kind: "unreachable" as const, detail: response.detail };
      }
      const read = readSitemapResponse(response);
      if (read.kind === "redirect") {
        const target = normalizeUrl(read.location, site, url);
        if (target === null || !target.isInternal) {
          // A sitemap redirecting off-site would hand us another host's inventory.
          return {
            kind: "error" as const,
            detail: `${url} redirects off-site to ${read.location}`,
          };
        }
        // The location as the server wrote it, not the normalized identity. Gate 2:
        // `normalizeUrl` rewrites every alias to the canonical host, so an
        // apex-to-`www` redirect — and 145 of 312 prod hostnames are `www` aliases
        // (PRD §3) — normalizes back to the URL just fetched, and the hop re-requested
        // it and gave up. Internality is still checked through `normalizeUrl`; only the
        // URL we ask for comes from the server.
        const next = new URL(read.location, url).toString();
        if (next === url) {
          return { kind: "error" as const, detail: `${url} redirects to itself` };
        }
        findings.push({
          kind: "sitemap-degraded",
          detail: `${url} redirected (HTTP ${response.status}) to ${next}`,
        });
        url = next;
        continue;
      }
      if (read.kind === "not-a-sitemap") {
        // A 404 is an answer: that path is not a sitemap, try the next candidate. Any
        // other refusal — 401/403 from Wordfence, 429, 5xx — is not an answer, and
        // treating it as one is how a throttled host gets filed as sourceless. A 2xx
        // whose body is not a sitemap counts as an answer: the server replied fine.
        const answered =
          response.status === 404 || (response.status >= 200 && response.status < 300);
        return answered
          ? { kind: "absent" as const, detail: read.detail }
          : { kind: "error" as const, detail: `${url}: ${read.detail}` };
      }
      if (read.degraded !== null) {
        findings.push({
          kind: "sitemap-degraded",
          detail:
            `${url} answered ${read.degraded} and its body is a valid sitemap of ` +
            `${read.doc.locs.length} entr(ies), which is used`,
        });
      }
      return { kind: "doc" as const, doc: read.doc };
    }
    return { kind: "error" as const, detail: `${url} redirects more than once` };
  };

  // The entry point: the first candidate that is a sitemap at all.
  let entry: Awaited<ReturnType<typeof fetchDoc>> | null = null;
  const refused: string[] = [];
  for (const candidate of SITEMAP_CANDIDATES) {
    const url = `https://${site.canonicalHost}${candidate}`;
    if (seen.has(url)) continue;
    seen.add(url);
    entry = await fetchDoc(url);
    if (entry.kind === "doc") break;
    // A host that is not answering will not answer a different path, and an exhausted
    // budget will not refill: those stop the loop. A refusal of one PATH does not —
    // Gate 2 round 2: a 403 on `/sitemap_index.xml` was preventing `/wp-sitemap.xml`
    // from ever being tried, which on a WP-core host is where the only sitemap is.
    if (entry.kind === "unreachable") break;
    if (entry.kind === "error") {
      // Recorded whatever happens next, not only when nothing else answers: a 403 on
      // `/sitemap_index.xml` is worth knowing about even when `/wp-sitemap.xml` then
      // serves the whole inventory, and dropping it once a later candidate succeeds is
      // the "catch and continue without recording the degradation" §1 forbids.
      findings.push({ kind: "sitemap-degraded", detail: entry.detail });
      refused.push(entry.detail);
      continue;
    }
  }
  // A candidate that refused us is not an answer, so "this site has no sitemap" cannot
  // be concluded from the ones that 404'd around it.
  if (refused.length > 0 && entry?.kind !== "doc") {
    return incomplete(refused.join("; "));
  }
  if (entry === null || entry.kind === "absent") {
    return { kind: "absent", urls: [], findings, requests };
  }
  if (entry.kind === "unreachable") {
    // Recorded, not just returned: `decide` reads the findings, and a host that answered
    // REST with a 404 and then dropped the sitemap connection would otherwise resolve as
    // "this site has no truth source" — permanently, and quietly.
    return {
      kind: "unreachable",
      urls: [],
      findings: [...findings, { kind: "sitemap-incomplete", detail: entry.detail }],
      requests,
    };
  }
  if (entry.kind === "error") return incomplete(entry.detail);

  const queue = entry.doc.kind === "index" ? [...entry.doc.locs] : [];
  if (entry.doc.kind === "urlset") locs.push(...entry.doc.locs);
  while (queue.length > 0) {
    // Non-null: length was just checked.
    const child = queue.shift() as string;
    const target = normalizeUrl(child, site);
    if (target === null || !target.isInternal) {
      return incomplete(`child sitemap ${child} is not on this site`);
    }
    if (seen.has(target.href)) continue;
    seen.add(target.href);
    const doc = await fetchDoc(target.href);
    if (doc.kind !== "doc") {
      // Part of a sitemap is not a sitemap: the pages in the child we could not read
      // would be missing from the inventory, and so unreportable as orphans.
      return incomplete(`child sitemap ${target.href}: ${doc.detail}`);
    }
    // PRD §4: index sitemaps nest. A nested index contributes children, not URLs.
    if (doc.doc.kind === "index") queue.push(...doc.doc.locs);
    else locs.push(...doc.doc.locs);
  }

  if (locs.length === 0) {
    return { kind: "absent", urls: [], findings, requests };
  }
  return {
    kind: "ok",
    urls: locs.map((url) => ({ url, postType: null })),
    findings,
    requests,
  };
}

export async function resolveTruthSource(
  site: TruthSite,
  deps: TruthDeps,
  options: ResolveOptions = {},
): Promise<TruthSourceResult> {
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  if (!Number.isInteger(maxRequests) || maxRequests < 1) {
    throw new Error(
      `resolveTruthSource: maxRequests must be a positive integer, got ${maxRequests}`,
    );
  }
  const findings: TruthFinding[] = [];
  let requests = 0;

  // --- WP REST (PRD §4, first) -----------------------------------------------------
  const typesUrl = `https://${site.canonicalHost}/wp-json/wp/v2/types`;
  const typesResponse = await deps.get(typesUrl);
  requests += 1;
  const declared = readPostTypes(typesUrl, typesResponse, findings);
  const rest: RestEnumeration =
    declared === null
      ? {
          kind: typesResponse.kind === "transport-error" ? "unreachable" : "absent",
          urls: [],
          postTypes: [],
          findings: [],
          requests: 0,
        }
      : await enumerateRest(
          site,
          contentPostTypes(declared),
          deps,
          maxRequests - requests,
        );
  requests += rest.requests;
  findings.push(...rest.findings);

  // --- Sitemap (PRD §4, second — read even when REST answered) ----------------------
  const sitemap = await enumerateSitemap(site, deps, maxRequests - requests);
  requests += sitemap.requests;
  findings.push(...sitemap.findings);

  // --- Node identity, then the union ----------------------------------------------
  const restUrls =
    rest.kind === "ok" ? normalize(rest, site, "REST", "rest-unusable", findings) : null;
  const sitemapUrls =
    sitemap.kind === "ok"
      ? normalize(sitemap, site, "the sitemap", "sitemap-incomplete", findings)
      : null;
  const { urls, counts } = mergeInventories(restUrls, sitemapUrls);

  const invisible = sitemapInvisible(counts);
  if (invisible !== null && invisible > 0) {
    findings.push({
      kind: "sitemap-invisible",
      detail: `${invisible} URL(s) are in WP REST and absent from the sitemap`,
    });
  }
  const missing = restMissing(counts);
  if (missing !== null && missing > 0) {
    findings.push({
      kind: "rest-missing",
      detail: `${missing} URL(s) are in the sitemap and absent from WP REST`,
    });
  }

  const kind = decide(site, findings, {
    rest: restUrls !== null,
    sitemap: sitemapUrls !== null,
    // Whether anything answered at all, threaded from the responses rather than
    // inferred from the enumerations' outcome. Gate 2 round 2: `enumerateRest` reports
    // `unreachable` when its FIRST collection request fails, which can happen after
    // `/wp-json/wp/v2/types` already answered — so inferring from the kinds made a host
    // that demonstrably answered come back as a quiet `unreachable`, and the same error
    // one request later threw instead. The outcome must not turn on the request index.
    reached: typesResponse.kind === "response" || sitemap.kind !== "unreachable",
  });
  if ((kind === "rest" || kind === "sitemap") && urls.length === 0) {
    // Unreachable by construction — both enumerations refuse to return `ok` with
    // nothing — and asserted because "0 URLs" is the one inventory size that would
    // make every page of the site look absent from its own CMS.
    throw new Error(
      `truth source for ${site.siteId} resolved to ${kind} with no URLs at all`,
    );
  }
  return {
    kind,
    urls,
    postTypes: rest.kind === "ok" ? allPostTypes(declared ?? [], rest.postTypes) : [],
    counts,
    findings,
    requests,
  };
}

/**
 * The site's declared post types, or `null` if REST cannot supply them — recording why
 * whenever "why" is anything other than a plain 404. A 401 or 403 is a REST API that
 * exists and is blocked, and 429/5xx is a temporary failure; falling through to the
 * sitemap is right in all three cases, doing it silently is not.
 */
function readPostTypes(
  url: string,
  response: HttpResult,
  findings: TruthFinding[],
): readonly RestPostType[] | null {
  if (response.kind === "transport-error") {
    // Found by Gate 2: without this the site resolves from the sitemap alone with an
    // empty findings list, so integrity.com's 96-URL sitemap silently stands in for a
    // 124-page post type and `truth_source_rest_urls = NULL` — which is indistinguishable
    // from "this site has no REST API" — is the only trace.
    findings.push({ kind: "rest-unusable", detail: `${url}: ${response.detail}` });
    return null;
  }
  if (response.status === 200) {
    try {
      return parsePostTypes(JSON.parse(response.body));
    } catch (error) {
      // A 200 that is not a type map — a soft 404, an HTML error page, a plugin printing
      // a warning before the JSON. REST exists in some form, so this is a degradation to
      // report rather than "this site has no REST API".
      findings.push({ kind: "rest-unusable", detail: `${url}: ${message(error)}` });
      return null;
    }
  }
  if (response.status !== 404) {
    findings.push({ kind: "rest-unusable", detail: `${url}: HTTP ${response.status}` });
  }
  return null;
}

/**
 * The resolution order's answer, or an exception. There is deliberately no outcome that
 * says "no truth source" about a site whose truth source we merely failed to read:
 * `none` disables orphan detection for that site permanently and quietly, and PRD §13
 * puts the 47 sites with no truth source in a coverage report — a site that belongs
 * there by accident is worse than a loud failure.
 */
function decide(
  site: TruthSite,
  findings: readonly TruthFinding[],
  /** Whether each source produced a usable inventory, and whether the host answered. */
  probes: { rest: boolean; sitemap: boolean; reached: boolean },
): TruthSourceKind {
  if (probes.rest) return "rest";
  if (probes.sitemap) return "sitemap";
  // A host that never answered anything is `unreachable`, and that outranks the refusal
  // below: "no DNS" is a registry-health finding with a known remedy, not an unexplained
  // failure to read a truth source.
  if (!probes.reached) return "unreachable";
  const unresolved = findings.filter(
    (f) =>
      f.kind === "rest-unusable" ||
      f.kind === "rest-incomplete" ||
      f.kind === "rest-total-mismatch" ||
      f.kind === "sitemap-incomplete",
  );
  if (unresolved.length > 0) {
    throw new Error(
      `truth source for ${site.siteId} could not be resolved: ` +
        unresolved.map((f) => `${f.kind}: ${f.detail}`).join("; ") +
        `. Reporting this site as having no truth source would disable orphan ` +
        `detection for it silently.`,
    );
  }
  return "none";
}

/**
 * Normalize one source's URLs into node identity, reporting anything it drops — and
 * returning `null` rather than an empty list when it dropped everything.
 *
 * Found by review, not by a failing test: a sitemap listing 96 URLs of which none is on
 * this site left `counts.sitemap = 0`, and 0 is a count. `sitemap-invisible` is
 * `union - sitemap`, so every URL REST knew about would have been reported as missing
 * from a sitemap that had in fact told us nothing usable.
 */
function normalize(
  enumeration: Enumeration,
  site: TruthSite,
  label: string,
  emptyKind: TruthFindingKind,
  findings: TruthFinding[],
): readonly FoundUrl[] | null {
  const found = gather(enumeration.urls, site);
  const dropped: [readonly string[], string][] = [
    [found.foreign, "not on this site"],
    [found.unusable, "not crawlable pages"],
  ];
  for (const [urls, why] of dropped) {
    if (urls.length === 0) continue;
    findings.push({
      kind: "dropped-url",
      detail: `${urls.length} URL(s) listed by ${label} are ${why} (first: ${urls[0]})`,
    });
  }
  if (found.duplicates > 0) {
    findings.push({
      kind: "duplicate-url",
      detail: `${label} listed ${found.duplicates} URL(s) more than once`,
    });
  }
  if (found.urls.length === 0) {
    findings.push({
      kind: emptyKind,
      detail:
        `${label} listed ${enumeration.urls.length} URL(s) and none of them is a page ` +
        `of this site`,
    });
    return null;
  }
  return found.urls;
}

/** Every declared post type in declaration order, enumerated or skipped. */
function allPostTypes(
  declared: readonly RestPostType[],
  enumerated: readonly PostTypeInventory[],
): PostTypeInventory[] {
  const bySlug = new Map(enumerated.map((entry) => [entry.slug, entry]));
  return declared.map(
    (type) =>
      bySlug.get(type.slug) ?? {
        slug: type.slug,
        restBase: type.restBase,
        urls: 0,
        declaredTotal: null,
        skipped: skipReason(type),
      },
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
