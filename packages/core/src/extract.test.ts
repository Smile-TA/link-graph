/**
 * Link extraction against saved real HTML (test/fixtures/pages).
 *
 * Expected counts were derived from the raw markup WITHOUT cheerio — a regex over the
 * fixture text with HTML comments and `<script>`/`<style>` bodies stripped first (see
 * "what is not a link" below) — so they are not a transcript of what the
 * implementation happens to do. The per-link table for lionstreet-home was read off
 * the markup by hand.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractPage, type ExtractedPage } from "./extract.js";
import type { SiteHosts } from "./url.js";

const site = (host: string): SiteHosts => ({
  canonicalHost: host,
  aliases: [host, `www.${host}`],
});

const integrity = site("integrity.com");

/** `links`/`internal` are the counts derived from the markup, not from cheerio. */
const FIXTURES = {
  "403bplan-home.html": {
    url: "https://403bplan.net/",
    hosts: site("403bplan.net"),
    links: 17,
    internal: 10,
  },
  "403bplan-newsletter-canonicalized.html": {
    url: "https://403bplan.net/newsletter-signup/?ref=lgtest",
    hosts: site("403bplan.net"),
    links: 14,
    internal: 7,
  },
  "integrity-home.html": {
    url: "https://integrity.com/",
    hosts: integrity,
    links: 58,
    internal: 46,
  },
  "lionstreet-home.html": {
    url: "https://lionstreet.com/",
    hosts: site("lionstreet.com"),
    links: 25,
    internal: 17,
  },
  "tidewater-home.html": {
    url: "https://tidewatermg.com/",
    hosts: site("tidewatermg.com"),
    links: 346,
    internal: 313,
  },
  "tidewater-search-noindex.html": {
    url: "https://tidewatermg.com/?s=medicare",
    hosts: site("tidewatermg.com"),
    links: 79,
    internal: 59,
  },
} as const;

/** `extractPage` is pure, so every test shares one extraction per fixture. */
const parsed = new Map<string, ExtractedPage>(
  Object.entries(FIXTURES).map(([file, f]) => [
    file,
    extractPage(
      readFileSync(
        fileURLToPath(new URL(`../test/fixtures/pages/${file}`, import.meta.url)),
        "utf8",
      ),
      f.url,
      f.hosts,
    ),
  ]),
);

const extracted = (file: string): ExtractedPage => {
  const page = parsed.get(file);
  if (page === undefined) throw new Error(`no such fixture: ${file}`);
  return page;
};

describe("extractPage: the whole link set of one real page", () => {
  // lionstreet-home has 28 `<a href>`; three are not crawlable pages (a bare `#`
  // skip-link, a `tel:` and a `javascript:`), leaving 25. Every row below was
  // transcribed from the markup, in document order.
  const { links } = extracted("lionstreet-home.html");

  it("yields exactly the expected link set", () => {
    const actual = links.map((l) => `${l.container} ${l.target.href} ${l.anchor}`);
    expect(actual).toEqual([
      "header https://lionstreet.com/ ",
      "header https://lionstreet.com/about/ About",
      "header https://lionstreet.com/elite-network/ Elite Network",
      "header https://lionstreet.com/work-with-a-firm/ Work With A Firm",
      "header https://lionstreet.com/becoming-a-firm/ Becoming a Firm",
      "header https://lionstreet.com/what-we-offer/ What We Offer",
      "header https://lionstreet.com/testimonials/ Testimonials",
      "header https://lionstreet.com/contact/ Contact",
      "header https://mylionstreet.com/ Login",
      "main https://lionstreet.com/elite-network/ Find a Lion Street Firm",
      "main https://lionstreet.com/work-with-a-firm/ Work With A Firm",
      "main https://lionstreet.com/becoming-a-firm/ Becoming A Firm",
      "main https://lionstreet.com/what-we-offer/ What We Offer",
      // href is /about#post-section: the fragment goes, the WP slash arrives.
      "main https://lionstreet.com/about/ View All News & Events",
      "main https://lionstreet.com/2026/07/25-financial-professionals-named-on-forbes-top-financial-security-professionals-2026/ READ MORE",
      "main https://lionstreet.com/2026/06/trusted-advisors-conference-2026/ READ MORE",
      "main https://lionstreet.com/2026/05/lion-street-university-2026-insights-into-new-business-processing-underwriting-developments-case-design-ai-and-more/ READ MORE",
      "footer https://lionstreet.com/ ",
      "footer https://integritymarketing.wd1.myworkdayjobs.com/Lionstreet Careers",
      "footer https://integrity.com/privacy-policy/ Privacy Policy",
      // href carries a trailing space: "https://brokercheck.finra.org/ ".
      "footer https://brokercheck.finra.org/ FINRA's BrokerCheck",
      // External, so step 1 must NOT invent a trailing slash here.
      "footer https://integrity.com/terms-of-service Terms & Conditions",
      "footer https://submit-irm.trustarc.com/services/validation/d14968e7-edec-4831-b5f2-c494567844f6/?brandId=ebf18504-6165-4a69-ba0a-10dd8ad93adc Do Not Sell or Share My Personal Information",
      "footer https://integrity.com/consumer-health-data-privacy-notice Consumer Health Data Privacy Notice",
      "footer https://www.linkedin.com/company/lion-street/ ",
    ]);
  });

  it("counts DOM position over every anchor, including the ones it skips", () => {
    // Anchor 0 is the `#int-content` skip-link, which is not a crawlable page. The
    // first link we emit is therefore anchor 1, not anchor 0 — otherwise a position
    // could not be traced back to the markup.
    expect(links[0]?.domIndex).toBe(1);
    expect(links.at(-1)?.domIndex).toBe(27);
  });

  it("records rel verbatim and derives nofollow from its tokens", () => {
    const login = links.find((l) => l.target.host === "mylionstreet.com");
    expect(login?.rel).toBe("noopener noreferrer");
    expect(login?.isNofollow).toBe(false);
    expect(links.find((l) => l.rel === null)?.isNofollow).toBe(false);
  });
});

describe("extractPage: link counts across every fixture", () => {
  for (const [file, f] of Object.entries(FIXTURES)) {
    it(`extracts ${String(f.links)} links (${String(f.internal)} internal) from ${file}`, () => {
      const { links } = extracted(file);
      expect(links.length).toBe(f.links);
      expect(links.filter((l) => l.target.isInternal).length).toBe(f.internal);
    });
  }

  it("attributes a nav nested in a header to the header, not the nav", () => {
    // Every estate theme sampled wraps its menu as `<header><nav>`, so the nearest
    // landmark would collapse header and footer navs into one indistinguishable
    // "nav". The outermost landmark keeps the page region, which is the thing a
    // boilerplate report has to name.
    const { links } = extracted("integrity-home.html");
    const dist: Record<string, number> = {};
    for (const l of links) dist[l.container] = (dist[l.container] ?? 0) + 1;
    expect(dist).toEqual({ header: 24, main: 10, footer: 24 });
  });
});

describe("extractPage: what is not a link", () => {
  it("ignores an anchor inside an HTML comment", () => {
    // 403bplan-home has five commented-out anchors, one of which is the only
    // homepage link to /newsletter-signup — a page that is in the sitemap. A
    // regex extractor would report it as linked and hide a real orphan.
    const { links } = extracted("403bplan-home.html");
    expect(links.map((l) => l.target.path)).toContain("/plan-participant/");
    expect(links.map((l) => l.target.path)).not.toContain("/newsletter-signup/");
    expect(links.some((l) => l.target.host === "twitter.com")).toBe(false);
    expect(links.some((l) => l.target.host === "www.facebook.com")).toBe(false);
  });

  it("ignores an anchor inside a script body", () => {
    // tidewater-home embeds seven `<a href>` in a WS Form JS error string.
    const { links } = extracted("tidewater-home.html");
    expect(links.length).toBe(346);
    expect(links.some((l) => l.target.host === "wsform.com")).toBe(false);
  });

  it("drops mailto, tel, javascript and bare-fragment anchors", () => {
    const { links } = extracted("lionstreet-home.html");
    // The three dropped anchors are `#int-content`, `tel:5127768400` and
    // `javascript:void(0);`; the 25 that remain are what the site actually links to.
    expect(links.length).toBe(25);
    expect(links.map((l) => l.target.href).join(" ")).not.toMatch(
      /mailto:|tel:|javascript:/,
    );
  });
});

describe("extractPage: anchor text", () => {
  const { links } = extracted("tidewater-home.html");

  it("decodes entities in anchor text", () => {
    const l = links.find(
      (x) => x.target.path === "/insurance-agent-reviews-testimonials/",
    );
    expect(l?.anchor).toBe("Agent Reviews & Testimonials");
  });

  it("collapses the whitespace a page builder leaves around anchor text", () => {
    expect(links.some((l) => l.anchor === "Pamela Johnson")).toBe(true);
    expect(links.some((l) => /^\s|\s$|\n/.test(l.anchor))).toBe(false);
  });

  it("does not read an inline SVG's stylesheet as anchor text", () => {
    // Illustrator exports `<svg><defs><style>.cls-1{fill:#717171}</style>`, and
    // cheerio's .text() concatenates it. Two links across the captures — this one and
    // the Logout link on the search page — came out as ".cls-1{fill:#717171;}…VIP
    // Portal", which would make the (target, anchor) boilerplate key depend on the
    // theme's icon CSS.
    const vip = links.find((l) => l.target.path === "/vip-portal/");
    expect(vip?.anchor).toBe("VIP Portal");
    expect(links.filter((l) => l.anchor.includes("{"))).toEqual([]);
  });

  it("leaves an icon-only anchor empty rather than inventing text for it", () => {
    // The two logo links (anchors 5 and 339) wrap an `<img alt="Tidewater Management
    // Group logo">` and have no visible text. Substituting the alt would be a
    // labelling decision, and (target, anchor) still aggregates fine with "".
    const logos = links.filter((l) => l.domIndex === 5 || l.domIndex === 339);
    expect(
      logos.map((l) => `${l.container} ${l.target.path} ${JSON.stringify(l.anchor)}`),
    ).toEqual(['header / ""', 'footer / ""']);
  });
});

describe("extractPage: HTML entities in an href are the parser's job", () => {
  // url.test.ts pins what happens when they are not decoded: everything from the `#`
  // becomes a fragment and is stripped, leaving a dangling `&`. This is the real
  // occurrence in the estate — one `<a href>` out of the 584 in the six captures.
  it("decodes &#038; before the href reaches normalizeUrl", () => {
    const { links } = extracted("tidewater-search-noindex.html");
    const logout = links.filter((l) => l.target.path.startsWith("/wp-login.php"));
    expect(logout.map((l) => l.target.path)).toEqual([
      "/wp-login.php?_wpnonce=76e5523bda&action=logout",
    ]);
  });
});

describe("extractPage: relative hrefs resolve against the page", () => {
  it("resolves a root-relative href against the page URL", () => {
    const { links } = extracted("integrity-home.html");
    expect(links.map((l) => l.target.href)).toContain(
      "https://integrity.com/platform/overview/",
    );
  });

  it("resolves a root-relative href on a page that is not the root", () => {
    const { links } = extracted("tidewater-search-noindex.html");
    expect(links.map((l) => l.target.href)).toContain(
      "https://tidewatermg.com/vip-portal/",
    );
  });

  it("resolves a schemeless host as the relative path it literally is", () => {
    // tidewater-home carries href="aging02.imgwebhost.com/resources/" — a staging
    // host written without a scheme, so per RFC 3986 it is a relative path. It
    // resolves inside the site and is almost certainly a 404; reporting it as an
    // external link to aging02.imgwebhost.com would hide a real broken link.
    const { links } = extracted("tidewater-home.html");
    const l = links.find((x) => x.target.path.includes("imgwebhost"));
    expect(l?.target.href).toBe(
      "https://tidewatermg.com/aging02.imgwebhost.com/resources/",
    );
    expect(l?.target.isInternal).toBe(true);
  });
});

describe("extractPage: head signals", () => {
  it("reads title, self-canonical and an indexable robots directive", () => {
    const { head } = extracted("tidewater-home.html");
    expect(head.title).toBe(
      "Medicare & Life Insurance Agent Resource Tidewater Management Group",
    );
    expect(head.canonical?.href).toBe("https://tidewatermg.com/");
    expect(head.robots).toEqual([
      "index",
      "follow",
      "max-image-preview:large",
      "max-snippet:-1",
      "max-video-preview:-1",
    ]);
    expect(head.noindex).toBe(false);
    expect(head.baseHref).toBeNull();
  });

  it("reports noindex, and a missing canonical as missing", () => {
    // A WordPress search-results page: Yoast emits `noindex, follow` and no canonical
    // at all. Absent must not read as "canonical equals this page".
    const { head } = extracted("tidewater-search-noindex.html");
    expect(head.noindex).toBe(true);
    expect(head.robots).toEqual(["noindex", "follow"]);
    expect(head.canonical).toBeNull();
    expect(head.title).toBe("You searched for medicare - Tidewater Management Group");
  });

  it("normalizes a canonical that points somewhere other than the page", () => {
    // Fetched as /newsletter-signup/?ref=lgtest; the canonical drops the query. This
    // is the signal PRD §2's Excluded class is built on.
    const { head } = extracted("403bplan-newsletter-canonicalized.html");
    expect(head.canonical?.href).toBe("https://403bplan.net/newsletter-signup/");
    expect(head.canonical?.path).toBe("/newsletter-signup/");
    expect(head.noindex).toBe(false);
  });

  it("reports nofollow links without treating the page as noindex", () => {
    const { links, head } = extracted("tidewater-search-noindex.html");
    const privacy = links.find((l) => l.target.path === "/privacy-notice/");
    expect(privacy?.rel).toBe("nofollow noopener noreferrer");
    expect(privacy?.isNofollow).toBe(true);
    expect(links.filter((l) => l.isNofollow).length).toBe(3);
    expect(head.robots).not.toContain("nofollow");
  });
});

describe("extractPage: cases the estate captures do not contain", () => {
  // No page in the six captures carries a `<base href>`, a mixed-case `robots` or
  // `canonical` attribute value, or an inline `<svg><title>`. They are all cheap to
  // get wrong in ways no fixture would catch, so they use minimal documents.
  const { links, head } = extractPage(
    `<!doctype html><html><head>
     <base href="/es/">
     <title>Inicio</title>
     <link rel="Canonical" href="bienvenida/">
     <meta name="ROBOTS" content="NoIndex, Follow">
     </head><body><svg><title>icon</title></svg>
     <main><a href="contacto/">Contacto</a></main></body></html>`,
    "https://integrity.com/a/b/",
    integrity,
  );

  it("resolves relative hrefs against <base href>, not the page URL", () => {
    expect(links[0]?.target.href).toBe("https://integrity.com/es/contacto/");
  });

  it("reports <base href> resolved to an absolute URL", () => {
    expect(head.baseHref).toBe("https://integrity.com/es/");
  });

  it("resolves the canonical against <base href> too", () => {
    expect(head.canonical?.href).toBe("https://integrity.com/es/bienvenida/");
  });

  it("matches the robots meta whatever the case of its name and content", () => {
    expect(head.robots).toEqual(["noindex", "follow"]);
    expect(head.noindex).toBe(true);
  });

  it("takes the title from the head, not from an inline SVG", () => {
    expect(head.title).toBe("Inicio");
    // An inline `<svg><title>` is a title element too. A head without one must report
    // null rather than borrowing an icon's label.
    const svgOnly = `<html><head></head><body><svg><title>icon</title></svg></body></html>`;
    expect(
      extractPage(svgOnly, "https://integrity.com/x/", integrity).head.title,
    ).toBeNull();
  });

  it("treats meta robots `none` as noindex", () => {
    // Google documents `none` as equivalent to `noindex, nofollow`. Unobserved in the
    // estate; a missed noindex is a phantom orphan, so it is honoured anyway.
    const none = extractPage(
      `<html><head><meta name="robots" content="none"></head><body></body></html>`,
      "https://integrity.com/x/",
      integrity,
    );
    expect(none.head.noindex).toBe(true);
  });

  it("finds noindex in a robots value written without commas", () => {
    // Every SEO plugin in the estate writes a comma-separated list, but a
    // hand-edited `content="noindex nofollow"` is honoured by Google and must not
    // read as indexable here.
    const spaced = extractPage(
      `<html><head><meta name="robots" content="noindex nofollow"></head><body></body></html>`,
      "https://integrity.com/x/",
      integrity,
    );
    expect(spaced.head.noindex).toBe(true);
    expect(spaced.head.robots).toEqual(["noindex nofollow"]);
  });

  it("skips a canonical link that carries no href", () => {
    // An href-less `<link rel=canonical>` must not shadow the real one: `null` feeds
    // the Excluded class, so reading it as "no canonical" would be a false negative.
    const two = extractPage(
      `<html><head><link rel="canonical"><link rel="canonical" href="/real/"></head><body></body></html>`,
      "https://integrity.com/x/",
      integrity,
    );
    expect(two.head.canonical?.href).toBe("https://integrity.com/real/");
  });

  it("falls back to the page URL when <base href> is unparseable", () => {
    const bad = extractPage(
      `<html><head><base href="http://["></head><body><a href="c/">c</a></body></html>`,
      "https://integrity.com/a/b/",
      integrity,
    );
    expect(bad.head.baseHref).toBeNull();
    expect(bad.links[0]?.target.href).toBe("https://integrity.com/a/b/c/");
  });
});

describe("extractPage: a failure must not look like an empty page", () => {
  it("throws on empty HTML rather than reporting a page with no links", () => {
    const call = () => extractPage("   ", "https://integrity.com/", integrity);
    expect(call).toThrow(/empty/);
    expect(call).toThrow(/https:\/\/integrity\.com\//);
  });

  it("throws when the page URL is not absolute, rather than dropping every link", () => {
    // Without an absolute base, every relative href silently normalizes to null and
    // the page reports zero internal links.
    expect(() => extractPage(`<a href="/a/">a</a>`, "/relative/", integrity)).toThrow(
      /\/relative\//,
    );
  });

  it("throws when the page URL parses but is not http(s)", () => {
    // `new URL("/a/", "mailto:x@y.z")` fails, so every relative href would be dropped
    // one at a time and the page would look like it links nowhere.
    expect(() => extractPage(`<a href="/a/">a</a>`, "mailto:x@y.z", integrity)).toThrow(
      /mailto:x@y\.z/,
    );
  });
});
