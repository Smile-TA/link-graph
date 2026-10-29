import { describe, expect, it } from "vitest";
import { normalizeUrl, siteHosts } from "./url.js";

// Fixtures are real hosts from the estate (docs/census.json), not invented ones.
const lionstreet = {
  canonicalHost: "lionstreet.com",
  aliases: ["lionstreet.com", "www.lionstreet.com"],
};

describe("normalizeUrl", () => {
  it("treats a www alias as the same site as the apex host", () => {
    const apex = normalizeUrl("https://lionstreet.com/about/", lionstreet);
    const www = normalizeUrl("https://www.lionstreet.com/about/", lionstreet);
    expect(www?.href).toBe(apex?.href);
    expect(www?.isInternal).toBe(true);
  });

  it("upgrades http to https and lowercases the host", () => {
    const r = normalizeUrl("http://WWW.LionStreet.com/About/", lionstreet);
    expect(r?.href).toBe("https://lionstreet.com/About/");
  });

  it("strips the fragment but keeps the path", () => {
    const r = normalizeUrl("https://lionstreet.com/privacy/#texting", lionstreet);
    expect(r?.href).toBe("https://lionstreet.com/privacy/");
  });

  it("strips tracking parameters and keeps meaningful ones", () => {
    const r = normalizeUrl(
      "https://lionstreet.com/x/?utm_source=a&id=7&fbclid=z",
      lionstreet,
    );
    expect(r?.href).toBe("https://lionstreet.com/x/?id=7");
  });

  it("keeps the root-relative path, matching the pw-template convention", () => {
    const r = normalizeUrl("https://lionstreet.com/team/bob/", lionstreet);
    expect(r?.path).toBe("/team/bob/");
  });

  it("marks a genuinely different host as external", () => {
    const r = normalizeUrl("https://integrity.com/privacy-policy/", lionstreet);
    expect(r?.isInternal).toBe(false);
    expect(r?.host).toBe("integrity.com");
  });

  it("resolves a relative href against the page it was found on", () => {
    const r = normalizeUrl("../contact/", lionstreet, "https://lionstreet.com/a/b/");
    expect(r?.href).toBe("https://lionstreet.com/a/contact/");
  });

  it("returns null for non-navigable schemes rather than throwing", () => {
    expect(normalizeUrl("mailto:a@b.com", lionstreet)).toBeNull();
    expect(normalizeUrl("tel:+15551234567", lionstreet)).toBeNull();
    expect(normalizeUrl("javascript:void(0)", lionstreet)).toBeNull();
    expect(normalizeUrl("#anchor-only", lionstreet)).toBeNull();
  });

  it("returns null for unparseable input rather than throwing", () => {
    expect(normalizeUrl("http://", lionstreet)).toBeNull();
    expect(normalizeUrl("", lionstreet)).toBeNull();
  });
});

describe("normalizeUrl: trailing slash policy", () => {
  // Measured 2026-08-19: lionstreet.com/about, integrity.com/careers and
  // tidewatermg.com/contact all 301 to the trailing-slash form. WordPress's
  // canonical form for an extensionless path has the slash.
  it("adds a trailing slash to an extensionless internal path", () => {
    expect(normalizeUrl("https://lionstreet.com/about", lionstreet)?.href).toBe(
      "https://lionstreet.com/about/",
    );
  });

  it("leaves an internal path with a file extension alone", () => {
    const r = normalizeUrl("https://lionstreet.com/wp-content/x/logo.svg", lionstreet);
    expect(r?.href).toBe("https://lionstreet.com/wp-content/x/logo.svg");
  });

  it("leaves the root path as a bare slash", () => {
    expect(normalizeUrl("https://lionstreet.com", lionstreet)?.href).toBe(
      "https://lionstreet.com/",
    );
  });

  // /ClientsSSO is real (connect.integrity.com, found in integrity.com's homepage).
  // We do not know an external host's routing, so we must not invent a form for it.
  it("never rewrites the path of an external URL", () => {
    const r = normalizeUrl("https://connect.integrity.com/ClientsSSO", lionstreet);
    expect(r?.href).toBe("https://connect.integrity.com/ClientsSSO");
    expect(r?.isInternal).toBe(false);
  });

  // Measured 2026-08-19: /wp-json/wp/v2/types answers 200 both slashed and unslashed
  // and never redirects, so there is no canonical form for us to converge on.
  it("does not slash WordPress REST routes, which are not permalinks", () => {
    expect(
      normalizeUrl("https://lionstreet.com/wp-json/wp/v2/types", lionstreet)?.path,
    ).toBe("/wp-json/wp/v2/types");
  });

  it("does not double a slash that is already there", () => {
    expect(normalizeUrl("https://lionstreet.com/about/", lionstreet)?.href).toBe(
      "https://lionstreet.com/about/",
    );
  });
});

describe("normalizeUrl: WordPress duplicate forms", () => {
  it("collapses /index.php to the root", () => {
    expect(normalizeUrl("https://lionstreet.com/index.php", lionstreet)?.href).toBe(
      "https://lionstreet.com/",
    );
  });

  it("collapses /index.php while keeping an identity-bearing query", () => {
    expect(normalizeUrl("https://lionstreet.com/index.php?p=123", lionstreet)?.href).toBe(
      "https://lionstreet.com/?p=123",
    );
  });

  // ?p= and ?page_id= ARE the identity — they cannot be resolved to a pretty
  // permalink without a fetch, so redirect following (PRD §5) collapses them later.
  it("keeps ?p= and ?page_id=, which identify the resource", () => {
    expect(normalizeUrl("https://lionstreet.com/?p=123", lionstreet)?.path).toBe(
      "/?p=123",
    );
    expect(normalizeUrl("https://lionstreet.com/?page_id=7", lionstreet)?.path).toBe(
      "/?page_id=7",
    );
  });

  it("strips ?replytocom, which WordPress adds to every comment link", () => {
    expect(
      normalizeUrl("https://lionstreet.com/post/?replytocom=42", lionstreet)?.path,
    ).toBe("/post/");
  });

  it("keeps ?s= search URLs for classification rather than dropping them", () => {
    expect(normalizeUrl("https://lionstreet.com/?s=annuity", lionstreet)?.path).toBe(
      "/?s=annuity",
    );
  });
});

describe("normalizeUrl: percent-encoding", () => {
  it("uppercases percent-escape hex digits", () => {
    expect(normalizeUrl("https://lionstreet.com/a%2fb.pdf", lionstreet)?.path).toBe(
      "/a%2Fb.pdf",
    );
  });

  it("decodes needlessly-escaped unreserved characters", () => {
    expect(normalizeUrl("https://lionstreet.com/%7Euser/", lionstreet)?.path).toBe(
      "/~user/",
    );
  });

  // Real href from 403bplan.net's homepage. The escaping is load-bearing here.
  it("preserves escaping that changes meaning", () => {
    const r = normalizeUrl(
      "https://lionstreet.com/wp-json/oembed/1.0/embed?url=https%3A%2F%2Flionstreet.com%2F",
      lionstreet,
    );
    expect(r?.path).toBe("/wp-json/oembed/1.0/embed?url=https%3A%2F%2Flionstreet.com%2F");
  });
});

describe("normalizeUrl: HTML entities are the parser's job", () => {
  // WordPress emits &#038; for & inside href attributes (6 of 371 hrefs captured from
  // the estate). Undecoded, everything from the # onward is a fragment and gets
  // stripped, leaving a dangling &. cheerio decodes attributes, so step 2 hands us
  // text — this test pins the contract rather than adding a second decoder here.
  it("normalizes correctly once entities are decoded", () => {
    const r = normalizeUrl(
      "https://lionstreet.com/wp-json/oembed/1.0/embed?url=https%3A%2F%2Flionstreet.com%2F&format=xml",
      lionstreet,
    );
    expect(r?.path).toBe(
      "/wp-json/oembed/1.0/embed?format=xml&url=https%3A%2F%2Flionstreet.com%2F",
    );
  });

  it("treats an undecoded entity as the fragment it literally is", () => {
    const r = normalizeUrl("https://lionstreet.com/a/?x=1&#038;format=xml", lionstreet);
    expect(r?.path).toBe("/a/?x=1&");
  });
});

describe("normalizeUrl: ports, schemes and hosts", () => {
  it("drops a default port", () => {
    expect(normalizeUrl("http://lionstreet.com:80/a/", lionstreet)?.href).toBe(
      "https://lionstreet.com/a/",
    );
    expect(normalizeUrl("https://lionstreet.com:443/a/", lionstreet)?.href).toBe(
      "https://lionstreet.com/a/",
    );
  });

  it("keeps a non-default port, which denotes a different service", () => {
    expect(normalizeUrl("https://other.com:8080/a/", lionstreet)?.href).toBe(
      "https://other.com:8080/a/",
    );
  });

  // Real href from integrity.com's homepage: http://hollmanmedia.com . We know our own
  // estate is https-only; we know nothing about anyone else's TLS, and a broken-link
  // report must show the URL that was actually linked.
  it("leaves an external http URL on http", () => {
    const r = normalizeUrl("http://hollmanmedia.com", lionstreet);
    expect(r?.href).toBe("http://hollmanmedia.com/");
    expect(r?.isInternal).toBe(false);
  });

  it("resolves a protocol-relative href against the page's scheme", () => {
    const r = normalizeUrl(
      "//www.lionstreet.com/team/",
      lionstreet,
      "https://lionstreet.com/",
    );
    expect(r?.href).toBe("https://lionstreet.com/team/");
  });

  it("converts an internationalized host to punycode", () => {
    expect(normalizeUrl("https://münchen.de/a/", lionstreet)?.host).toBe(
      "xn--mnchen-3ya.de",
    );
  });

  // Paths are case-sensitive; only the host is not. Real href: /Integrity_LogoIcon.svg
  it("preserves path case while lowercasing the host", () => {
    const r = normalizeUrl("https://LionStreet.com/wp-content/Logo_Icon.svg", lionstreet);
    expect(r?.href).toBe("https://lionstreet.com/wp-content/Logo_Icon.svg");
  });

  it("ignores tabs and newlines inside an href", () => {
    expect(normalizeUrl("https://lionstreet.com/a\n\tbout/", lionstreet)?.path).toBe(
      "/about/",
    );
  });
});

describe("normalizeUrl: query ordering", () => {
  it("sorts multiple parameters so order does not create two nodes", () => {
    const a = normalizeUrl("https://lionstreet.com/x/?b=2&a=1", lionstreet);
    const b = normalizeUrl("https://lionstreet.com/x/?a=1&b=2", lionstreet);
    expect(a?.href).toBe(b?.href);
  });

  // Real href: integrity.com/xmlrpc.php?rsd . Sorting would rewrite it to "?rsd=",
  // so a single parameter is left exactly as found.
  it("does not mangle a lone valueless parameter", () => {
    expect(normalizeUrl("https://lionstreet.com/xmlrpc.php?rsd", lionstreet)?.path).toBe(
      "/xmlrpc.php?rsd",
    );
  });

  it("drops a query that consisted only of tracking parameters", () => {
    expect(normalizeUrl("https://lionstreet.com/x/?utm_source=a", lionstreet)?.path).toBe(
      "/x/",
    );
  });
});

describe("siteHosts", () => {
  const site = {
    canonicalHost: "lionstreet.com",
    aliases: ["lionstreet.com", "www.lionstreet.com"],
    stageHost: "lionstreet-2024.staging02.example.com",
  };

  it("returns the prod host and aliases unchanged when not staging", () => {
    expect(siteHosts(site, false)).toEqual({
      canonicalHost: "lionstreet.com",
      aliases: ["lionstreet.com", "www.lionstreet.com"],
    });
  });

  it("returns the stage host as its own sole alias when staging", () => {
    expect(siteHosts(site, true)).toEqual({
      canonicalHost: "lionstreet-2024.staging02.example.com",
      aliases: ["lionstreet-2024.staging02.example.com"],
    });
  });

  it("refuses a staging request for a site with no stage host", () => {
    expect(() => siteHosts({ ...site, stageHost: null }, true)).toThrow(/no stage host/);
  });
});

describe("normalizeUrl bare query marker", () => {
  it("drops a dangling `?` so `/?` and `/` are one URL", () => {
    const site = {
      canonicalHost: "planenroll.com",
      aliases: ["planenroll.com"],
    };
    expect(normalizeUrl("https://www.facebook.com/?", site)?.href).toBe(
      "https://www.facebook.com/",
    );
    expect(normalizeUrl("https://planenroll.com/privacy-notice/?", site)?.href).toBe(
      "https://planenroll.com/privacy-notice/",
    );
  });
});
