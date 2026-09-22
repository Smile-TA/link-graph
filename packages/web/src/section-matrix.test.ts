import { describe, expect, it } from "vitest";
import { buildSectionMatrix, sectionOf } from "./section-matrix.js";
import type { LinkRow, PageRow } from "@link-graph/db";

function page(id: number, path: string): PageRow {
  return {
    id,
    crawlId: 1,
    urlNormalized: `https://example.com${path}`,
    path,
    postType: null,
    statusCode: 200,
    depth: 0,
    inTruthSource: true,
    indexable: true,
    canonicalTo: null,
    redirectTo: null,
    class: "linked",
  };
}

function link(overrides: Partial<LinkRow>): LinkRow {
  return {
    id: 1,
    crawlId: 1,
    fromPageId: 1,
    toUrlNormalized: "https://example.com/",
    toPageId: null,
    anchor: "",
    rel: null,
    isExternal: false,
    isBoilerplate: false,
    container: "main",
    domIndex: 0,
    ...overrides,
  };
}

describe("sectionOf", () => {
  it("names the homepage / and every other page its first path segment", () => {
    expect(sectionOf("/")).toBe("/");
    expect(sectionOf("/blog/")).toBe("/blog/");
    expect(sectionOf("/blog/post-1/")).toBe("/blog/");
  });
});

describe("buildSectionMatrix", () => {
  const pages = [
    page(1, "/"),
    page(2, "/blog/"),
    page(3, "/blog/post-1/"),
    page(4, "/about/"),
  ];

  it("lists every section with a crawled page, / first then alphabetical", () => {
    const { sections } = buildSectionMatrix(pages, []);
    expect(sections).toEqual(["/", "/about/", "/blog/"]);
  });

  it("counts contextual internal edges between sections, zero-filled", () => {
    const links = [
      link({ id: 1, fromPageId: 1, toPageId: 2 }), // / -> /blog/
      link({ id: 2, fromPageId: 3, toPageId: 4 }), // /blog/ -> /about/
      link({ id: 3, fromPageId: 3, toPageId: 2 }), // /blog/ -> /blog/ (within-section)
    ];
    const { counts } = buildSectionMatrix(pages, links);
    expect(counts.get("/")!.get("/blog/")).toBe(1);
    expect(counts.get("/blog/")!.get("/about/")).toBe(1);
    expect(counts.get("/blog/")!.get("/blog/")).toBe(1);
    expect(counts.get("/about/")!.get("/blog/")).toBe(0);
  });

  it("excludes external links, boilerplate links, self-links, and unresolved targets", () => {
    const links = [
      link({ id: 1, fromPageId: 1, toPageId: 2, isExternal: true }),
      link({ id: 2, fromPageId: 1, toPageId: 2, isBoilerplate: true }),
      link({ id: 3, fromPageId: 1, toPageId: 2, isBoilerplate: null }),
      link({ id: 4, fromPageId: 1, toPageId: 1 }),
      link({ id: 5, fromPageId: 1, toPageId: null }),
    ];
    const { counts } = buildSectionMatrix(pages, links);
    expect(counts.get("/")!.get("/blog/")).toBe(0);
    expect(counts.get("/")!.get("/")).toBe(0);
  });
});
