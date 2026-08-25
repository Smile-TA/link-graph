import { describe, expect, it } from "vitest";
import { normalizeUrl, type SiteHosts } from "@link-graph/core";
import { isCrawlableTarget } from "./target.js";

const site: SiteHosts = {
  canonicalHost: "403bplan.net",
  aliases: ["403bplan.net", "www.403bplan.net"],
};

const path = (href: string): string => {
  const url = normalizeUrl(href, site);
  if (url === null) throw new Error(`not a URL: ${href}`);
  return url.path;
};

describe("isCrawlableTarget", () => {
  it("admits WordPress permalinks, which carry no extension", () => {
    for (const href of [
      "https://403bplan.net/",
      "https://403bplan.net/plan-participant/fund-prospectuses/",
      "https://403bplan.net/?s=403b",
      "https://403bplan.net/page/2/",
    ]) {
      expect([href, isCrawlableTarget(path(href))]).toEqual([href, true]);
    }
  });

  it("refuses the 17 real PDF links on 403bplan.net", () => {
    // Measured from the checked-in captures: the site's 26 distinct internal targets
    // are its 9 linked pages and these 17 uploads. Fetching them would put 17 rows in
    // `pages` for things that are not pages, and every one of them would need a
    // response the fixture server does not have (see crawl.int.test.ts).
    for (const href of [
      "https://403bplan.net/wp-content/uploads/2019/07/IRS-Audit-Guarantee-1.pdf",
      "https://403bplan.net/wp-content/uploads/2026/07/Vanguard-Bond-Funds-Prospectus.pdf",
      "https://403bplan.net/wp-content/uploads/2026/04/DFA-Prospectus-Fixed.pdf",
    ]) {
      expect([href, isCrawlableTarget(path(href))]).toEqual([href, false]);
    }
  });

  it("admits the extensions that do serve HTML", () => {
    // `.php` is WordPress's own (`/index.php` is normalized away, but a plugin
    // endpoint is not), and a hand-written `.html` page is still a page.
    expect(isCrawlableTarget("/wp-login.php")).toBe(true);
    expect(isCrawlableTarget("/legacy/about.html")).toBe(true);
    expect(isCrawlableTarget("/legacy/about.htm")).toBe(true);
  });

  it("refuses assets and feeds a page inventory would never list", () => {
    for (const p of [
      "/wp-content/themes/x/style.css",
      "/wp-content/uploads/2026/07/logo.png",
      "/wp-content/uploads/2026/07/brochure.PDF",
      "/wp-content/uploads/2026/07/deck.pptx",
      "/sitemap_index.xml",
    ]) {
      expect([p, isCrawlableTarget(p)]).toEqual([p, false]);
    }
  });

  it("looks at the last segment only, so a dotted directory is still a page", () => {
    expect(isCrawlableTarget("/2026.07/report/")).toBe(true);
  });

  it("ignores the query when deciding, since ?s= is a page and .pdf?v=2 is not", () => {
    expect(isCrawlableTarget("/?s=403b&post_type=page")).toBe(true);
    expect(isCrawlableTarget("/wp-content/uploads/a.pdf?v=2")).toBe(false);
  });
});
