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

describe("isCrawlableTarget calendar exports", () => {
  it("refuses iCal export URLs, which are not pages", () => {
    for (const p of [
      "/events/month/?ical=1",
      "/events/today/?ical=1",
      "/events/?outlook-ical=1&tribe-bar-date=2026-10",
      "/insurance-agent-training/list/page/6/?tribe-bar-date=2026-08-15",
      "/page/5/?eventDate=2026-10-24&eventDisplay=day&post_type=tribe_events",
      "/insurance-agent-training/list/page/9/?eventDisplay=past&tribe-bar-date=2026-10-14",
      "/?post_type=tribe_events",
    ]) {
      expect([p, isCrawlableTarget(p)]).toEqual([p, false]);
    }
  });
});

describe("isCrawlableTarget calendar date paths", () => {
  it("refuses pretty-permalink day and month views", () => {
    for (const p of [
      "/events/2026-10-26/",
      "/events/month/2026-10/",
      "/events/2027-01",
      "/event-calendar/week/2026-10-14/",
      "/event-calendar/tag/sales-strategy/day/2026-10-15/",
      "/events/tag/bankers-fidelity/day/2026-10-26/",
      "/events/tag/manhattan-life/2027-01/",
      "/events/category/webinar/day/2026-08-01/?tribe_event_display=day",
    ]) {
      expect([p, isCrawlableTarget(p)]).toEqual([p, false]);
    }
  });

  it("still admits the events pages themselves", () => {
    for (const p of [
      "/events/",
      "/events/tag/medicare-supplement/",
      "/event/webinar-live-from-pipac-its-friday-morning-5/",
      "/events/2026-planning-guide/",
      "/blog/2026-10/",
      "/event-calendar/",
    ]) {
      expect([p, isCrawlableTarget(p)]).toEqual([p, true]);
    }
  });
});

describe("isCrawlableTarget near the calendar parameters", () => {
  it("still admits ordinary pagination and queries", () => {
    for (const p of [
      "/page/2/",
      "/?s=events",
      "/events/",
      "/blog/?paged=2",
      "/?post_type=page",
    ]) {
      expect([p, isCrawlableTarget(p)]).toEqual([p, true]);
    }
  });
});
