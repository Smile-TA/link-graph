/**
 * Corpus properties over real estate data (test/fixtures/README.md).
 *
 * These assert invariants rather than individual cases: a normalization bug that
 * slips past the hand-written examples in url.test.ts almost always shows up here as
 * a canonical URL that got rewritten, or a function that is not idempotent.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeUrl, type SiteHosts } from "./url.js";

const fixture = (name: string): string[] =>
  readFileSync(
    fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)),
    "utf8",
  )
    .split("\n")
    .filter((l) => l.trim() !== "");

/** Treat each URL's own host as canonical, with the usual apex/www alias pair. */
const siteFor = (host: string): SiteHosts => ({
  canonicalHost: host.replace(/^www\./, ""),
  aliases: [host, host.replace(/^www\./, ""), `www.${host.replace(/^www\./, "")}`],
});

describe("corpus: canonical sitemap URLs", () => {
  const urls = fixture("sitemap-urls.txt");

  it("has a corpus to test against", () => {
    expect(urls.length).toBeGreaterThan(250);
  });

  it("normalizes every canonical URL to itself, unchanged", () => {
    const rewritten: string[] = [];
    for (const url of urls) {
      const host = new URL(url).hostname;
      const result = normalizeUrl(url, siteFor(host));
      if (result?.href !== url) rewritten.push(`${url} -> ${String(result?.href)}`);
    }
    expect(rewritten).toEqual([]);
  });

  it("classifies every canonical URL as internal to its own site", () => {
    const external = urls.filter((url) => {
      const host = new URL(url).hostname;
      return normalizeUrl(url, siteFor(host))?.isInternal !== true;
    });
    expect(external).toEqual([]);
  });
});

describe("corpus: raw hrefs from real pages", () => {
  const hrefs = fixture("raw-hrefs.txt");
  const site = siteFor("integrity.com");

  it("has a corpus to test against", () => {
    expect(hrefs.length).toBeGreaterThan(300);
  });

  it("never throws, whatever the input", () => {
    for (const href of hrefs) {
      expect(() => normalizeUrl(href, site, "https://integrity.com/")).not.toThrow();
    }
  });

  it("is idempotent: normalizing an already-normalized URL changes nothing", () => {
    const unstable: string[] = [];
    for (const href of hrefs) {
      const once = normalizeUrl(href, site, "https://integrity.com/");
      if (once === null) continue;
      const twice = normalizeUrl(once.href, site, "https://integrity.com/");
      if (twice?.href !== once.href)
        unstable.push(`${once.href} -> ${String(twice?.href)}`);
    }
    expect(unstable).toEqual([]);
  });

  it("always produces a path that starts with a single slash", () => {
    const bad = hrefs
      .map((h) => normalizeUrl(h, site, "https://integrity.com/"))
      .filter((r) => r !== null)
      .filter((r) => !r.path.startsWith("/") || r.path.startsWith("//"));
    expect(bad).toEqual([]);
  });
});
