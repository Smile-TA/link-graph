/**
 * The link pattern that failed step 7's gate, as a fixture host.
 *
 * **What it reproduces.** The full prod crawl of integrity.com on 2026-08-25 reported
 * 538 orphans, ~89% of them false, and 480 of those came from two pages of one shape:
 * `/about-us/our-partners/` serves 70 KB carrying **one** `/partner/` href and **zero**
 * partner slugs anywhere — including inside the JS payloads — while the site has 274
 * partner pages, and `/inspire/?sf_paged=16` serves 90 KB whose only 12 `inspire` links
 * are pagination links. Both are rendered client-side from `admin-ajax.php` (PRD §5,
 * plan step 7). An HTTP-only crawl cannot see one of those 480 links, which is what
 * turned real pages into reported orphans.
 *
 * **These bytes are a reproduction of a measured shape, not a capture, and that is a
 * deliberate limit.** No capture of that page exists in this repo, the crawl that found
 * it is over, and re-fetching it is a live request to the estate. What is copied
 * verbatim from a real capture is the mechanism: `packages/core/test/fixtures/pages/
 * integrity-home.html` carries
 * `var SF_LDATA = {"ajax_url":"https://integrity.com/wp-admin/admin-ajax.php", …}`
 * beside `<script id="search-filter-plugin-build-js">`, which is Search & Filter Pro
 * telling its bundle where to fetch results from. The one deviation is that `ajax_url`
 * here is root-relative rather than absolute: the fixture server answers on a local
 * origin, and an absolute `https://integrity.com/…` inside the page would send the
 * browser to the real host.
 *
 * **The slugs exist in exactly one place: the `admin-ajax` response.** Not in the page,
 * not in the script, not in a JSON island. That is what the measurement found and it is
 * what makes this fixture decisive — a page that merely hid its links inside an inline
 * array would be found by any parser and would prove nothing about rendering.
 */
import type { FixtureHandler, FixtureResponse } from "./fixture-server.js";

/**
 * The real host, for the reason `fixture-server.ts` gives: node identity is what the
 * crawl stores, and a fixture that renamed the host would exercise a different graph.
 * Only the connection is local. Nothing here is a capture of integrity.com.
 */
export const HOST = "integrity.com";

export const DIRECTORY_PATH = "/about-us/our-partners/";
export const DIRECTORY_URL = `https://${HOST}${DIRECTORY_PATH}`;

/**
 * Four partners rather than the site's 274: the decisive property is that an HTTP fetch
 * finds none of them and a rendered fetch finds all of them, and that is the same
 * property at four as at 274 for a tenth of the wall clock.
 */
export const PARTNER_SLUGS: readonly string[] = [
  "aetna",
  "humana",
  "mutual-of-omaha",
  "wellcare",
];

export const partnerPath = (slug: string): string => `/partner/${slug}/`;
export const partnerUrl = (slug: string): string => `https://${HOST}${partnerPath(slug)}`;

/** What every page of this estate is served as. Measured 2026-08-24 on 403bplan.net. */
const HTML: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=UTF-8",
};

const JSON_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json; charset=UTF-8",
};

const BUNDLE_PATH = "/wp-content/plugins/search-filter-pro/js/build.js";
const AJAX_PATH = "/wp-admin/admin-ajax.php";
const RESULTS_ID = "search-filter-results-1234";

/**
 * The directory as the server renders it: one `/partner/` href (the archive), an empty
 * results container, and the localized `ajax_url` its bundle reads. The stylesheet and
 * the image are here because they are what a browser would fetch and a link crawler
 * must not — see `playwright-fetcher.ts` on why those resource types are aborted.
 */
const DIRECTORY_HTML = `<!doctype html>
<html lang="en-US">
<head>
<meta charset="UTF-8">
<title>Our Partners - Integrity</title>
<link rel="canonical" href="${DIRECTORY_URL}">
<link rel="stylesheet" id="theme-css" href="/wp-content/themes/integritymarketing2023/dist/css/main.css">
</head>
<body>
<header><a href="https://${HOST}/">Integrity</a></header>
<main>
<h1>Our Partners</h1>
<p><a href="https://${HOST}/partner/">View all partners</a></p>
<div class="searchandfilter" data-sf-form-id="1234"></div>
<div id="${RESULTS_ID}"></div>
<img src="/wp-content/uploads/2025/01/partners-hero.jpg" alt="">
</main>
<footer><a href="https://${HOST}/privacy-policy/">Privacy Policy</a></footer>
<script id="search-filter-plugin-build-js-extra">
var SF_LDATA = {"ajax_url":"${AJAX_PATH}","home_url":"/","extensions":[]};
//# sourceURL=search-filter-plugin-build-js-extra
</script>
<script id="search-filter-plugin-build-js" src="${BUNDLE_PATH}"></script>
</body>
</html>
`;

/**
 * The bundle. It waits for `DOMContentLoaded` and then a further 250ms before asking
 * for results, so that a fetcher which stopped at `load` would come back with the empty
 * container — which is the failure this fetcher exists to remove, and a fixture that
 * resolved during parse could not tell the two apart.
 */
const BUNDLE_JS = `document.addEventListener("DOMContentLoaded", function () {
  window.setTimeout(function () {
    fetch(SF_LDATA.ajax_url + "?action=get_results&sf_paged=1")
      .then(function (response) { return response.json(); })
      .then(function (data) {
        document.getElementById("${RESULTS_ID}").innerHTML = data.results
          .map(function (item) {
            return '<a href="' + item.permalink + '">' + item.title + "</a>";
          })
          .join("");
      });
  }, 250);
});
`;

/** The only place a partner slug exists. */
const AJAX_JSON = JSON.stringify({
  results: PARTNER_SLUGS.map((slug) => ({
    permalink: partnerUrl(slug),
    title: slug,
  })),
});

/** A partner page: real, indexable, and linked from nowhere an HTTP crawl can see. */
const partnerHtml = (slug: string): string => `<!doctype html>
<html lang="en-US">
<head><meta charset="UTF-8"><title>${slug} - Integrity</title>
<link rel="canonical" href="${partnerUrl(slug)}"></head>
<body><main><h1>${slug}</h1>
<p><a href="${DIRECTORY_URL}">Back to partners</a></p></main></body>
</html>
`;

export const servePartnerDirectory: FixtureHandler = (path: string): FixtureResponse => {
  if (path === DIRECTORY_PATH)
    return { status: 200, headers: HTML, body: DIRECTORY_HTML };
  if (path === BUNDLE_PATH) {
    return {
      status: 200,
      headers: { "content-type": "application/javascript" },
      body: BUNDLE_JS,
    };
  }
  if (path.startsWith(`${AJAX_PATH}?`)) {
    return { status: 200, headers: JSON_HEADERS, body: AJAX_JSON };
  }
  const slug = PARTNER_SLUGS.find((candidate) => path === partnerPath(candidate));
  if (slug !== undefined) return { status: 200, headers: HTML, body: partnerHtml(slug) };
  // A WordPress 404 serves the whole site nav; the fixture keeps it minimal because
  // nothing parses one (record.ts).
  return { status: 404, headers: HTML, body: "<html>404</html>" };
};
