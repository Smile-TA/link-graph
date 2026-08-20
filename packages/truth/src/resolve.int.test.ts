/**
 * `resolveTruthSource` against the live estate — the one test in this package that uses
 * the network (implementation plan, step 5).
 *
 * Three hosts, one from each of the cohorts the step has to distinguish, and 11 requests
 * in total at the default 1 req/s (PRD §5.1 — Wordfence returns 503 above ~8 req/s and
 * bans the source IP for an hour, so this test is deliberately small and never
 * parallel).
 *
 * **The assertions are structural, not a page count.** These are live sites: asserting
 * "13 URLs" would turn publishing a page on 403bplan.net into a test failure. What is
 * asserted instead is what must be true whatever the content is — that both sources
 * resolve, that they agree with each other, and that every URL is node identity the
 * crawler could store. The exact figures measured on 2026-08-20 are in the unit tests,
 * against recorded responses.
 *
 * There is no skip-if-offline path: a suite that goes green because it could not reach
 * the estate is engineering guide §1 wearing a tick.
 */
import { describe, expect, it } from "vitest";
import { normalizeUrl } from "@link-graph/core";
import { createHttpFetcher } from "./http.js";
import { resolveTruthSource, type TruthSite } from "./resolve.js";

const site = (host: string): TruthSite => ({
  siteId: host.replace(/\./g, "-"),
  canonicalHost: host,
  aliases: [host, `www.${host}`],
});

const deps = createHttpFetcher();

describe("resolveTruthSource against live estate hosts", () => {
  it(
    "resolves 403bplan.net from WP REST, and the sitemap agrees",
    async () => {
      const started = Date.now();
      const result = await resolveTruthSource(site("403bplan.net"), deps);

      expect(result.kind).toBe("rest");
      // The cross-check PRD §13 asks for, on live data: both sources read, and the
      // union is no larger than either — so neither knows a URL the other does not.
      expect(result.counts.rest).not.toBeNull();
      expect(result.counts.sitemap).toBe(result.counts.rest);
      expect(result.counts.total).toBe(result.counts.rest);
      // 13 on 2026-08-20; asserted as a floor so that publishing a page is not a
      // failure, and as non-empty because an empty inventory is never an answer.
      expect(result.urls.length).toBeGreaterThanOrEqual(13);
      // No finding that means something could not be read. Asserted as a filter rather
      // than an empty list: publishing a post on this site adds a sitemap child, and a
      // redirect on one of the candidates is a `sitemap-degraded` note, neither of which
      // is a failure to resolve.
      expect(
        result.findings.filter(
          (f) => f.kind.endsWith("incomplete") || f.kind.endsWith("unusable"),
        ),
      ).toEqual([]);

      // Every URL is a normalizeUrl fixed point on this site, which is what makes it
      // joinable to `pages.url_normalized` (the fixture loader refuses anything else).
      for (const url of result.urls) {
        const normalized = normalizeUrl(url.url, site("403bplan.net"));
        expect(normalized?.href).toBe(url.url);
        expect(normalized?.isInternal).toBe(true);
        expect(url.inRest && url.inSitemap).toBe(true);
        expect(url.postType).toBe("page");
      }

      // Post types come from the site, not from a hardcoded list, and the nine
      // WordPress-internal ones are skipped rather than requested.
      const enumerated = result.postTypes.filter((t) => t.skipped === null);
      expect(enumerated.map((t) => t.slug).sort()).toEqual(["page", "post"]);
      expect(result.postTypes.filter((t) => t.skipped === "not-content")).toHaveLength(9);

      // The rate limit is the point of the default fetcher: n requests cannot take less
      // than n-1 intervals of a second. Written against the observed request count, so
      // that a post published on this site adding a sitemap child does not fail the
      // assertion that matters.
      expect(result.requests).toBeGreaterThanOrEqual(5);
      expect(Date.now() - started).toBeGreaterThanOrEqual((result.requests - 1) * 1000);
    },
    { timeout: 30_000 },
  );

  it(
    "reports 123.planenroll.com as having no truth source at all",
    async () => {
      // One of the 47 reachable hosts with neither source (PRD §1). Its orphans are
      // undetectable, and that is a coverage gap rather than a zero.
      const result = await resolveTruthSource(site("123.planenroll.com"), deps);
      expect(result.kind).toBe("none");
      expect(result.urls).toEqual([]);
      expect(result.counts).toEqual({ total: null, rest: null, sitemap: null });
      // REST plus all three sitemap candidates: 'none' is only reported once every path
      // in PRD §4 has answered.
      expect(result.requests).toBe(4);
      expect(result.findings).toEqual([]);
    },
    { timeout: 30_000 },
  );

  it(
    "reports the dead host agents.integrity.com as unreachable, not as sourceless",
    async () => {
      // No DNS, and it holds a live pw-template config (PRD §3.1). "We could not ask"
      // and "there is nothing to ask for" have different remedies.
      const result = await resolveTruthSource(site("agents.integrity.com"), deps);
      expect(result.kind).toBe("unreachable");
      expect(result.counts).toEqual({ total: null, rest: null, sitemap: null });
    },
    { timeout: 30_000 },
  );
});
