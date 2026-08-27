/**
 * The browser adapter against a real socket and a real Chromium.
 *
 * The first test is the whole justification for this dependency: the same bytes, from
 * the same server, read two ways. If the HTTP fetcher could see these links, the
 * browser would be ~300x the cost for nothing.
 *
 * **Every fixture here is served with root-relative subresource URLs, and that is a
 * requirement rather than a style.** The fixture server rewrites the *connection* for
 * undici, not the URLs; a browser resolves hosts itself, so a page carrying
 * `<script src="https://403bplan.net/…">` would fetch it from the real host. The
 * checked-in production captures are all of that shape and are therefore unusable
 * here — see `fixture-server.ts`.
 *
 * Integration tier, not unit: it launches a browser and opens sockets, and the unit
 * tier does neither (engineering guide §4.3).
 */
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { extractPage, normalizeUrl, type SiteHosts } from "@link-graph/core";
import { createHttpFetcher } from "./fetcher.js";
import { createPlaywrightFetcher } from "./playwright-fetcher.js";
import { recordPage } from "./record.js";
import {
  DIRECTORY_PATH,
  DIRECTORY_URL,
  HOST,
  PARTNER_SLUGS,
  partnerPath,
  servePartnerDirectory,
} from "./testing/partner-directory.js";
import {
  startFixtureServer,
  type FixtureHandler,
  type FixtureServer,
} from "./testing/fixture-server.js";

const SITE: SiteHosts = { canonicalHost: HOST, aliases: [HOST, `www.${HOST}`] };

/** One browser for the file: launching costs ~2.4s cold, and nothing here shares state. */
const fetcher = createPlaywrightFetcher();

const servers: FixtureServer[] = [];
async function serve(handler: FixtureHandler): Promise<FixtureServer> {
  const server = await startFixtureServer({ [HOST]: handler });
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

afterAll(async () => {
  await fetcher.close?.();
});

/** The partner pages this body links to, as `extractPage` would record them. */
function partnerLinks(body: string): string[] {
  return extractPage(body, DIRECTORY_URL, SITE)
    .links.map((link) => link.target.path)
    .filter((path) => /^\/partner\/[^/]+\/$/.test(path));
}

async function body(fetch: () => Promise<{ kind: string }>): Promise<string> {
  const result = (await fetch()) as { kind: string; status?: number; body?: string };
  if (result.kind !== "response")
    throw new Error(`expected a response, got ${result.kind}`);
  expect(result.status).toBe(200);
  return result.body ?? "";
}

describe("createPlaywrightFetcher", () => {
  it("finds the links an HTTP fetch cannot see, from the same bytes", async () => {
    const server = await serve(servePartnerDirectory);
    const url = `${server.originFor(HOST)}${DIRECTORY_PATH}`;
    const http = createHttpFetcher();
    let served: string;
    try {
      served = await body(() => http.get(url));
    } finally {
      await http.close?.();
    }
    const rendered = await body(() => fetcher.get(url));

    // What step 7 measured on the real page: one `/partner/` href (the archive), no
    // partner page, and no slug anywhere at all — not in the markup, not in the script.
    expect(partnerLinks(served)).toEqual([]);
    for (const slug of PARTNER_SLUGS) expect(served).not.toContain(slug);

    // …and the same response, rendered, carries every one of them.
    expect(partnerLinks(rendered)).toEqual(PARTNER_SLUGS.map(partnerPath));
  });

  it("fetches the document, its scripts and its XHR — and no images or stylesheets", async () => {
    const server = await serve(servePartnerDirectory);
    await body(() => fetcher.get(`${server.originFor(HOST)}${DIRECTORY_PATH}`));

    // PRD §5.1's limiter counts one `get`, so what the browser does inside one counts
    // against the same Wordfence. A stylesheet and an image cannot contain an `<a
    // href>`, so they are requests bought with no link found.
    expect(server.requests).toEqual([
      `${HOST}${DIRECTORY_PATH}`,
      `${HOST}/wp-content/plugins/search-filter-pro/js/build.js`,
      `${HOST}/wp-admin/admin-ajax.php?action=get_results&sf_paged=1`,
    ]);
  });

  it("returns a redirect rather than following it", async () => {
    const server = await serve((path) =>
      path === "/moved/"
        ? { status: 301, headers: { location: DIRECTORY_PATH }, body: "" }
        : servePartnerDirectory(path),
    );
    const result = await fetcher.get(`${server.originFor(HOST)}/moved/`);

    // Which redirect is an alias hop and which is a `pages.redirect_to` needs the
    // site's alias set, so it is `fetch-page.ts`'s decision and this layer must not
    // pre-empt it — the same contract `createHttpFetcher` holds.
    expect(result).toMatchObject({ kind: "response", status: 301 });
    if (result.kind !== "response") throw new Error("unreachable");
    expect(result.headers["location"]).toBe(DIRECTORY_PATH);
    expect(result.body).toBe("");
    // A browser follows a redirect by itself, and the target would then be fetched and
    // rendered — a page nobody asked for, on a host the crawl may not even be crawling.
    expect(server.requests).toEqual([`${HOST}/moved/`]);
  });

  it("keeps the DOM of the URL it asked for when the page redirects itself", async () => {
    const server = await serve((path) =>
      path === "/js-redirect/"
        ? {
            status: 200,
            headers: { "content-type": "text/html; charset=UTF-8" },
            body:
              `<html><head><title>before</title></head><body><a href="https://${HOST}/stay/">` +
              `stay</a><script>setTimeout(function(){location.replace("${DIRECTORY_PATH}")},50)` +
              `</script></body></html>`,
          }
        : servePartnerDirectory(path),
    );
    const rendered = await body(() =>
      fetcher.get(`${server.originFor(HOST)}/js-redirect/`),
    );

    // A page that navigates itself would otherwise hand back one URL's identity with
    // another URL's DOM — every link on the partner directory recorded as an outbound
    // edge of `/js-redirect/`. Refused for the same reason a 301 is not followed here.
    expect(rendered).toContain("<title>before</title>");
    expect(rendered).not.toContain("Our Partners");
    expect(server.requests).toEqual([`${HOST}/js-redirect/`]);
  });

  it("returns a 404 as a status, without rendering the error page", async () => {
    const server = await serve(servePartnerDirectory);
    const result = await fetcher.get(`${server.originFor(HOST)}/nope/`);
    expect(result).toMatchObject({ kind: "response", status: 404 });
    // A WordPress 404 body is the site nav; parsing it would credit a missing page with
    // the whole menu (record.ts), so it is never buffered.
    if (result.kind !== "response") throw new Error("unreachable");
    expect(result.body).toBe("");
  });

  it("returns a transport failure as data, with the cause attached", async () => {
    // Port 1 on loopback: nothing listens. Chromium reports every such failure as
    // `net::ERR_FAILED`, which cannot tell a dead host from a slow one — the detail has
    // to carry the real cause, for the reason `packages/truth` records.
    const result = await fetcher.get("http://127.0.0.1:1/");
    expect(result.kind).toBe("transport-error");
    if (result.kind !== "transport-error") throw new Error("unreachable");
    expect(result.detail).toMatch(/ECONNREFUSED/);
  });

  it("returns a decoded body and no content-encoding, so recordPage can read it", async () => {
    const html =
      "<html><head><title>gz</title></head><body><a href='/a/'>a</a></body></html>";
    const server = await serve(() => ({
      status: 200,
      headers: { "content-type": "text/html; charset=UTF-8", "content-encoding": "gzip" },
      body: gzipSync(html),
    }));
    const result = await fetcher.get(`${server.originFor(HOST)}/gz/`);

    expect(result).toMatchObject({ kind: "response", status: 200 });
    if (result.kind !== "response") throw new Error("unreachable");
    expect(result.body).toContain("<title>gz</title>");
    // `recordPage` refuses a body served with an encoding this crawler did not ask for,
    // because undici would have handed cheerio bytes. The browser has already decoded
    // it and the body returned here is a re-serialized DOM, so the transfer header no
    // longer describes what is in `body` — keeping it would refuse every page of every
    // site that compresses, which is all of them.
    expect(result.headers["content-encoding"]).toBeUndefined();
    const url = normalizeUrl(`https://${HOST}/gz/`, SITE);
    if (url === null) throw new Error("unreachable");
    expect(() =>
      recordPage({
        url,
        inTruthSource: true,
        site: SITE,
        status: result.status,
        headers: result.headers,
        body: result.body,
        redirectTo: null,
      }),
    ).not.toThrow();
  });

  it("closes its browser once, and refuses to work after that", async () => {
    const own = createPlaywrightFetcher();
    const server = await serve(servePartnerDirectory);
    await body(() => own.get(`${server.originFor(HOST)}${DIRECTORY_PATH}`));
    await own.close?.();
    // `resolveDeps` calls `release` on every path including a throw, and a second close
    // must not become a second failure.
    await own.close?.();
    await expect(own.get(`${server.originFor(HOST)}${DIRECTORY_PATH}`)).rejects.toThrow(
      /closed/,
    );
  });

  it("closes without launching a browser it never needed", async () => {
    // `crawl` builds the fetcher before it opens the crawl row, and a refused crawl
    // returns without fetching anything. Launching Chromium there would cost 2.4s and
    // leave a process to reap for a crawl that never ran.
    const own = createPlaywrightFetcher();
    const started = Date.now();
    await own.close?.();
    expect(Date.now() - started).toBeLessThan(500);
  });
});
