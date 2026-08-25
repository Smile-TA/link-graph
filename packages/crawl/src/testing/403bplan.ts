/**
 * 403bplan.net as a fixture host: its 13 sitemap URLs, each answered with the
 * production response captured for step 4.
 *
 * **The bodies are read from `packages/analyse/test/fixtures/403bplan-net/` rather than
 * copied here.** They are 97 KB apiece and already exist twice — once in `packages/core`
 * for step 2 and once there for step 4 — and step 4's own module says the next step
 * needing them should merge rather than add a third copy. Merging means reworking two
 * committed test helpers, which is outside this step; reading them where they are adds
 * no copy and no package dependency, and is the smaller of the two wrongs.
 *
 * **Why this site.** It is the only site in the estate that has been captured whole, its
 * answer is known independently (step 4 derived 4 true orphans and 240 edges from these
 * same bytes by hand), and it is small enough that a crawl of it is a test rather than a
 * benchmark. Measured from the captures: the site's 26 distinct internal link targets
 * are 9 of these pages and 17 PDF uploads — so a crawl of it fetches these 13 URLs and
 * nothing else, which is exactly why the fixture server needs no response it does not
 * have (see `target.ts` on the admission policy).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FixtureHandler, FixtureResponse } from "./fixture-server.js";

export const HOST = "403bplan.net";
export const HOME_URL = `https://${HOST}/`;

const FIXTURES = fileURLToPath(
  new URL("../../../analyse/test/fixtures/403bplan-net/", import.meta.url),
);

/**
 * The 13 `<loc>` entries of `https://403bplan.net/page-sitemap.xml` in sitemap order,
 * each paired with its capture. `docs/census.json` independently records 13 URLs for
 * this host.
 */
const PAGES: Readonly<Record<string, string>> = {
  "/": "home.html",
  "/test-pay-button/": "test-pay-button.html",
  "/contact-us/": "contact-us.html",
  "/disclosures/": "disclosures.html",
  "/newsletter-signup/": "newsletter-signup.html",
  "/newsletters/": "newsletters.html",
  "/plan-participant/financial-calculators/":
    "plan-participant__financial-calculators.html",
  "/plan-participant/online-access/": "plan-participant__online-access.html",
  "/terms-of-service/": "terms-of-service.html",
  "/plan-participant/": "plan-participant.html",
  "/plan-sponsor/": "plan-sponsor.html",
  "/financial-advisor/": "financial-advisor.html",
  "/plan-participant/fund-prospectuses/": "plan-participant__fund-prospectuses.html",
};

/** Every sitemap URL, in sitemap order — the crawl's seed list. */
export const SITEMAP_URLS: readonly string[] = Object.keys(PAGES).map(
  (path) => `https://${HOST}${path}`,
);

/** What every page of this estate is served as. Measured 2026-08-24 on this host. */
export const HTML: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=UTF-8",
};

export function capture(file: string): string {
  return readFileSync(`${FIXTURES}${file}`, "utf8");
}

/**
 * The site as its origin answers it: 200 with the captured body for a sitemap URL, and
 * a 404 for everything else. Measured: all 13 returned 200 when captured at 1 req/s on
 * 2026-08-20, and 403bplan.net/terms-of-service/ still did on 2026-08-24.
 */
export const serve403bplan: FixtureHandler = (path: string): FixtureResponse => {
  const file = PAGES[path];
  // A WordPress 404 serves the whole site nav, which is why the crawler must not parse
  // one; the fixture keeps it minimal because the parse never happens.
  if (file === undefined) return { status: 404, headers: HTML, body: "<html>404</html>" };
  return { status: 200, headers: HTML, body: capture(file) };
};
