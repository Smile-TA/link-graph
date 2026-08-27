/**
 * WP REST parsing, against recorded production responses.
 *
 * Four things here were measured on 2026-08-20 and each one killed an assumption that
 * looked obviously right:
 *
 * - `viewable` is **absent** from an unauthenticated `/wp/v2/types` response (it is an
 *   `edit`-context field), so "enumerate the viewable types" cannot be implemented.
 * - `/wp/v2/blocks` answers **200 `[]`**, not 401, so "the ones that 401 are the
 *   internal ones" cannot be implemented either.
 * - `menu-items` and `templates` DO answer 401, so both shapes exist at once.
 * - `media` holds 4,681 items on integrity.com — twice the whole site's sitemap.
 */
import { describe, expect, it } from "vitest";
import {
  collectionUrl,
  contentPostTypes,
  parseCollectionPage,
  parsePostTypes,
  declaredTaxonomies,
  NON_CONTENT_POST_TYPES,
} from "./rest.js";
import { recordedBody, recordedResponse } from "./testing/recorded.js";

const types = (host: string) =>
  parsePostTypes(JSON.parse(recordedBody(`https://${host}/wp-json/wp/v2/types`)));

describe("parsePostTypes over real /wp-json/wp/v2/types", () => {
  it("enumerates all 20 of integrity.com's post types dynamically", () => {
    const all = types("integrity.com");
    expect(all).toHaveLength(20);
    // Eleven content types, of which pw-template's hardcoded `pages` scrape sees one.
    expect(contentPostTypes(all).map((t) => t.slug)).toEqual([
      "post",
      "page",
      "promotion",
      "webinar",
      "teammember",
      "blog",
      "partners",
      "inspire_podcasts",
      "women_in_leadership",
      "wealth",
      "insights",
    ]);
  });

  it("keeps post and page on a site that has nothing else (403bplan.net)", () => {
    const all = types("403bplan.net");
    expect(all).toHaveLength(11);
    expect(contentPostTypes(all).map((t) => t.slug)).toEqual(["post", "page"]);
  });

  it("finds 23 content types on tidewatermg.com, where PRD §4 expects 15", () => {
    const all = types("tidewatermg.com");
    expect(all).toHaveLength(32);
    const content = contentPostTypes(all).map((t) => t.slug);
    expect(content).toHaveLength(23);
    // PRD §4's "15 content post types" is the count of post-type children in the
    // sitemap index. REST knows six more content types than the sitemap does, plus the
    // four GenerateBlocks artifact types PRD §4 wants classified Excluded — which is
    // classification, not enumeration, so they are still enumerated here.
    expect(content).toContain("landing-pages");
    expect(content).toContain("legal");
    expect(content).toContain("gblocks_templates");
  });

  it("reads rest_base and rest_namespace rather than assuming the slug", () => {
    const media = types("integrity.com").find((t) => t.slug === "attachment");
    expect(media).toEqual({
      slug: "attachment",
      restBase: "media",
      namespace: "wp/v2",
      taxonomies: [],
    });
  });

  it("drops exactly the nine WordPress-internal types, on every site measured", () => {
    expect([...NON_CONTENT_POST_TYPES]).toEqual([
      "attachment",
      "nav_menu_item",
      "wp_block",
      "wp_template",
      "wp_template_part",
      "wp_global_styles",
      "wp_navigation",
      "wp_font_family",
      "wp_font_face",
    ]);
    for (const host of [
      "403bplan.net",
      "integrity.com",
      "tidewatermg.com",
      "agent.familyfirstlife.com",
    ]) {
      const all = types(host);
      expect(all.length - contentPostTypes(all).length).toBe(9);
    }
  });

  it("refuses a body that is not a type map", () => {
    expect(() => parsePostTypes([])).toThrow(/post type map/);
    expect(() => parsePostTypes({ post: { slug: "post" } })).toThrow(/rest_base/);
    expect(() => parsePostTypes({ post: null })).toThrow(/not a post type object/);
  });
});

describe("collectionUrl", () => {
  it("omits page=1 and asks only for the fields the inventory needs", () => {
    const page = types("integrity.com").find((t) => t.slug === "page");
    expect(collectionUrl("integrity.com", page!, 1)).toBe(
      "https://integrity.com/wp-json/wp/v2/pages" +
        "?per_page=100&orderby=id&order=asc&_fields=id,link,type,status",
    );
    expect(collectionUrl("integrity.com", page!, 2)).toContain("&page=2");
  });
});

describe("parseCollectionPage over real collections", () => {
  const page = (url: string) => parseCollectionPage(recordedResponse(url));
  const REST = "https://integrity.com/wp-json/wp/v2";
  const FIELDS = "per_page=100&orderby=id&order=asc&_fields=id,link,type,status";

  it("reads the declared total and whether another page follows", () => {
    const first = page(`${REST}/pages?${FIELDS}`);
    expect(first.items).toHaveLength(100);
    expect(first.declaredTotal).toBe(124);
    expect(first.declaredPages).toBe(2);
    expect(first.hasNext).toBe(true);
    const second = page(`${REST}/pages?${FIELDS}&page=2`);
    expect(second.items).toHaveLength(24);
    expect(second.hasNext).toBe(false);
  });

  it("reads the two post types integrity.com's sitemap does not mention", () => {
    expect(page(`${REST}/promotion?${FIELDS}`).declaredTotal).toBe(5);
    expect(page(`${REST}/webinar?${FIELDS}`).declaredTotal).toBe(10);
    expect(page(`${REST}/promotion?${FIELDS}`).items[0]?.link).toBe(
      "https://integrity.com/promotion/august-1-31/",
    );
  });

  it("reads an empty collection as empty rather than as an error", () => {
    // A post type with no posts is normal: 403bplan.net has none.
    const posts = page(`https://403bplan.net/wp-json/wp/v2/posts?${FIELDS}`);
    expect(posts.items).toEqual([]);
    expect(posts.declaredTotal).toBe(0);
    expect(posts.hasNext).toBe(false);
  });

  it("reports 4,681 media items — why `attachment` is not enumerated", () => {
    const media = page(`${REST}/media?per_page=1&_fields=id,link,type,status`);
    expect(media.declaredTotal).toBe(4681);
    // Not "publish": an attachment inherits its parent's status, and its permalink is
    // an attachment page rather than a page of the site.
    expect(media.items[0]?.status).toBe("inherit");
  });

  it("reads /wp/v2/blocks as an empty 200, which is why the skip list is not 401-based", () => {
    const blocks = page(`${REST}/blocks?per_page=1`);
    expect(blocks.items).toEqual([]);
    expect(blocks.declaredTotal).toBe(0);
  });

  it("refuses a page past the end of the collection, loudly", () => {
    // Measured: page 6 of a 5-page collection is 400 rest_post_invalid_page_number,
    // not an empty array. A resolver that read it as "no more items" would report a
    // 476-post type as 500 posts and call the run a success.
    expect(() => page(`${REST}/blog?${FIELDS}&page=6`)).toThrow(
      /rest_post_invalid_page_number/,
    );
  });

  it("refuses a 401 rather than treating it as an empty collection", () => {
    expect(() => page(`${REST}/menu-items?per_page=1`)).toThrow(/401/);
    expect(() => page(`${REST}/templates?per_page=1`)).toThrow(/401/);
  });

  it("refuses an item with no permalink", () => {
    expect(() =>
      parseCollectionPage({ status: 200, headers: {}, body: `[{"id":1}]` }),
    ).toThrow(/link/);
  });
});

/**
 * The taxonomy vocabulary, out of the request the resolver already makes.
 *
 * `/wp/v2/types` declares, per post type, the taxonomies registered for it — and that
 * is the only thing in the estate that can tell `insights_category-sitemap.xml` (a
 * taxonomy archive, PRD §4 Excluded) from `insights-sitemap.xml` (a content post type).
 * It costs no extra request.
 */
describe("declaredTaxonomies", () => {
  it("reads integrity.com's eight, which cover all five of its taxonomy children", () => {
    expect(declaredTaxonomies(types("integrity.com"))).toEqual([
      "category",
      "family_category",
      "insights_category",
      "nav_menu",
      "post_tag",
      "teammember_level",
      "wealth_category",
      "wp_pattern_category",
    ]);
  });

  it("reads tidewatermg.com's 23, for the site PRD §2 measured 164 archives on", () => {
    const tidewater = declaredTaxonomies(types("tidewatermg.com"));
    expect(tidewater).toHaveLength(23);
    expect(tidewater).toContain("gblocks_pattern_collections");
    expect(tidewater).toContain("university-series-taxonomy");
  });

  it("is four on a site with no custom taxonomy at all (403bplan.net)", () => {
    expect(declaredTaxonomies(types("403bplan.net"))).toEqual([
      "category",
      "nav_menu",
      "post_tag",
      "wp_pattern_category",
    ]);
  });

  /**
   * A name that is both would exclude a real content post type, which is the one
   * direction PRD §13 cannot afford — so the post types win and the name is dropped
   * from the vocabulary. No estate site has the collision (checked on all four
   * recorded type maps); the rule is here so that one cannot cause the failure
   * silently.
   */
  it("never lets a declared post type into the taxonomy vocabulary", () => {
    const collided = parsePostTypes({
      page: { slug: "page", rest_base: "pages", taxonomies: ["offer"] },
      offer: { slug: "offer", rest_base: "offers", taxonomies: [] },
    });
    expect(declaredTaxonomies(collided)).toEqual([]);
  });
});
