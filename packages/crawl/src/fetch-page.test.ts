/**
 * The redirect decision, against a fake fetcher. Unit tier: no network, no server.
 *
 * The two behaviours modelled here are both measured on this estate and cited in
 * PRD §5.1: the apex/www 301 that names the same node, and Wordfence's 503 with
 * `retry-after: 3600`.
 */
import { describe, expect, it } from "vitest";
import { normalizeUrl, type NormalizedUrl, type SiteHosts } from "@link-graph/core";
import { fetchPage } from "./fetch-page.js";
import type { FetchResult } from "./fetcher.js";

const site: SiteHosts = {
  canonicalHost: "403bplan.net",
  aliases: ["403bplan.net", "www.403bplan.net"],
};

const url = (href: string): NormalizedUrl => {
  const parsed = normalizeUrl(href, site);
  if (parsed === null) throw new Error(`not a URL: ${href}`);
  return parsed;
};

const now = () => new Date("2026-08-20T12:00:00Z");

const ok = (body: string): FetchResult => ({
  kind: "response",
  status: 200,
  headers: { "content-type": "text/html; charset=UTF-8" },
  body,
});

const moved = (location: string, status = 301): FetchResult => ({
  kind: "response",
  status,
  headers: { location },
  body: "",
});

/** Records what was asked for, which is how "one extra request per page" is checked. */
function fakeGet(routes: Record<string, FetchResult>): {
  get: (url: string) => Promise<FetchResult>;
  requested: string[];
} {
  const requested: string[] = [];
  return {
    requested,
    get: (target: string) => {
      requested.push(target);
      const response = routes[target];
      if (response === undefined) throw new Error(`fake fetcher has no route ${target}`);
      return Promise.resolve(response);
    },
  };
}

describe("fetchPage", () => {
  it("returns a served page with no hops", async () => {
    const fake = fakeGet({ "https://403bplan.net/": ok("<html>home</html>") });
    const outcome = await fetchPage({
      url: url("https://403bplan.net/"),
      site,
      ...fake,
      now,
    });
    expect(outcome).toEqual({
      kind: "page",
      status: 200,
      headers: { "content-type": "text/html; charset=UTF-8" },
      body: "<html>home</html>",
      redirectTo: null,
      aliasHops: 0,
    });
    expect(fake.requested).toEqual(["https://403bplan.net/"]);
  });

  it("follows a redirect that names the same node, and counts it", async () => {
    // The registry's canonical host is the apex; the server serves www. PRD §5.1.
    const fake = fakeGet({
      "https://403bplan.net/contact-us/": moved("https://www.403bplan.net/contact-us/"),
      "https://www.403bplan.net/contact-us/": ok("<html>contact</html>"),
    });
    const outcome = await fetchPage({
      url: url("https://403bplan.net/contact-us/"),
      site,
      ...fake,
      now,
    });
    expect(outcome).toMatchObject({
      kind: "page",
      status: 200,
      body: "<html>contact</html>",
      redirectTo: null,
      aliasHops: 1,
    });
    // One extra request, and the alias form is the one that was asked for second.
    expect(fake.requested).toEqual([
      "https://403bplan.net/contact-us/",
      "https://www.403bplan.net/contact-us/",
    ]);
  });

  it("records a redirect that names a different node instead of following it", async () => {
    const fake = fakeGet({
      "https://403bplan.net/old/": moved("https://403bplan.net/contact-us/"),
    });
    const outcome = await fetchPage({
      url: url("https://403bplan.net/old/"),
      site,
      ...fake,
      now,
    });
    expect(outcome).toMatchObject({
      kind: "page",
      status: 301,
      redirectTo: "https://403bplan.net/contact-us/",
      aliasHops: 0,
    });
    // Not followed: the target is a page of its own, and the frontier fetches it.
    expect(fake.requested).toEqual(["https://403bplan.net/old/"]);
  });

  it("resolves a relative Location against the URL actually requested", async () => {
    // WordPress emits absolute Locations, but RFC 9110 permits a relative one and a
    // wrong base here would invent a node under the wrong path.
    const fake = fakeGet({
      "https://403bplan.net/plan-participant/old/": moved("../online-access/"),
    });
    const outcome = await fetchPage({
      url: url("https://403bplan.net/plan-participant/old/"),
      site,
      ...fake,
      now,
    });
    expect(outcome).toMatchObject({
      redirectTo: "https://403bplan.net/plan-participant/online-access/",
    });
  });

  it("records a redirect off the site without following it", async () => {
    const fake = fakeGet({
      "https://403bplan.net/partner/": moved("https://integrity.com/", 302),
    });
    const outcome = await fetchPage({
      url: url("https://403bplan.net/partner/"),
      site,
      ...fake,
      now,
    });
    expect(outcome).toMatchObject({ status: 302, redirectTo: "https://integrity.com/" });
    expect(fake.requested).toEqual(["https://403bplan.net/partner/"]);
  });

  it("records a redirect with no usable Location rather than guessing one", async () => {
    const fake = fakeGet({
      "https://403bplan.net/broken/": {
        kind: "response",
        status: 301,
        headers: {},
        body: "",
      },
    });
    const outcome = await fetchPage({
      url: url("https://403bplan.net/broken/"),
      site,
      ...fake,
      now,
    });
    // Status 301 with no target: PRD §2 excludes it either way, and the row says why.
    expect(outcome).toMatchObject({ kind: "page", status: 301, redirectTo: null });
  });

  it("refuses an alias redirect loop rather than following it forever", async () => {
    const fake = fakeGet({
      "https://403bplan.net/loop/": moved("https://www.403bplan.net/loop/"),
      "https://www.403bplan.net/loop/": moved("https://403bplan.net/loop/"),
    });
    const outcome = await fetchPage({
      url: url("https://403bplan.net/loop/"),
      site,
      ...fake,
      now,
    });
    expect(outcome.kind).toBe("error");
    expect(outcome).toMatchObject({ detail: expect.stringMatching(/alias/i) as unknown });
    expect(fake.requested.length).toBeLessThanOrEqual(4);
  });

  it("reports the measured Wordfence block as throttled, with its retry-after", async () => {
    const fake = fakeGet({
      "https://403bplan.net/": {
        kind: "response",
        status: 503,
        headers: { "retry-after": "3600" },
        body: "",
      },
    });
    const outcome = await fetchPage({
      url: url("https://403bplan.net/"),
      site,
      ...fake,
      now,
    });
    expect(outcome).toMatchObject({
      kind: "throttled",
      status: 503,
      retryAfterSeconds: 3600,
    });
  });

  it("reports a transport error as an error, never as an empty page", async () => {
    const fake = {
      requested: [],
      get: (): Promise<FetchResult> =>
        Promise.resolve({
          kind: "transport-error",
          detail: "fetch failed: ECONNREFUSED",
        }),
    };
    const outcome = await fetchPage({
      url: url("https://403bplan.net/"),
      site,
      ...fake,
      now,
    });
    expect(outcome).toEqual({ kind: "error", detail: "fetch failed: ECONNREFUSED" });
  });
});
