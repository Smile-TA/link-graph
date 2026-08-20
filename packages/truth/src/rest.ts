/**
 * WP REST parsing: post types, one collection page, and the URL to ask for the next.
 * Pure — every function here is driven by responses recorded from the estate.
 *
 * **Enumerating the post types dynamically is the whole point of preferring REST**
 * (PRD §4). pw-template scrapes the `pages` post type only, which on integrity.com is
 * 124 of its ~2,000 URLs; the other 19 types hold the 476 blog entries, the team
 * members, the podcasts and the partners that nothing has ever checked.
 *
 * Three measurements on 2026-08-20 each killed a rule that looked obviously right:
 *
 * - **`viewable` is not in the response.** It is an `edit`-context field, so an
 *   unauthenticated `/wp/v2/types` never carries it — "enumerate the viewable types"
 *   cannot be implemented at all.
 * - **`/wp/v2/blocks` answers `200 []`**, so "the internal types are the ones that
 *   refuse" cannot be implemented either. `menu-items` and `templates` DO answer 401,
 *   so both shapes exist on one site.
 * - Which leaves the skip list below, and it is a list of WordPress's own types rather
 *   than a guess about any site's content.
 */
import type { HttpResponse } from "./http.js";

export interface RestPostType {
  readonly slug: string;
  readonly restBase: string;
  /** From `rest_namespace`; `wp/v2` on all four sites measured, but declared per type. */
  readonly namespace: string;
}

/**
 * WordPress's own post types, none of which is a page of the site. Measured identically
 * on all four estate sites probed, including one with no Yoast, and they are the same
 * nine whether the site has 11 types (403bplan.net) or 32 (tidewatermg.com).
 *
 * `attachment` is the one that needs justifying, because its permalinks are real:
 * `X-WP-Total` puts it at **4,681 items on integrity.com**, more than twice that site's
 * entire sitemap. The one item sampled is `status: inherit` rather than `publish` — an
 * attachment inherits its parent's status — and no sitemap in the estate lists an
 * attachment page. Enumerating them would cost 47 requests per
 * site and swamp the REST-versus-sitemap comparison with thousands of false
 * disagreements. Non-HTML internal targets are checked as links (PRD §6.1), not crawled
 * as pages.
 *
 * Plugin types are deliberately NOT listed. `bricks_template` and `gblocks_*` are
 * page-builder artifacts that PRD §4 wants in the Excluded class, and Excluded is a
 * classification of pages that exist — dropping them here would make them invisible
 * instead, which is a different and worse answer.
 */
export const NON_CONTENT_POST_TYPES: readonly string[] = [
  "attachment",
  "nav_menu_item",
  "wp_block",
  "wp_template",
  "wp_template_part",
  "wp_global_styles",
  "wp_navigation",
  "wp_font_family",
  "wp_font_face",
];

const NON_CONTENT = new Set(NON_CONTENT_POST_TYPES);

/** A `rest_base` that is a route template rather than a collection path. */
const TEMPLATED_REST_BASE = /[^A-Za-z0-9._~-]/;

export function parsePostTypes(json: unknown): RestPostType[] {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("wp/v2/types: expected a post type map keyed by slug");
  }
  return Object.entries(json as Record<string, unknown>).map(([key, value]) => {
    // Checked rather than cast: a `{"post": null}` body would otherwise throw a bare
    // TypeError, and that message is what gets recorded as the finding.
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`wp/v2/types: ${key} is not a post type object`);
    }
    const type = value as Record<string, unknown>;
    const restBase = type["rest_base"];
    if (typeof restBase !== "string" || restBase === "") {
      throw new Error(`wp/v2/types: ${key} has no rest_base`);
    }
    const slug = typeof type["slug"] === "string" ? type["slug"] : key;
    const namespace = type["rest_namespace"];
    return {
      slug,
      restBase,
      namespace: typeof namespace === "string" && namespace !== "" ? namespace : "wp/v2",
    };
  });
}

/** Why a post type will not be enumerated, or `null` if it will be. */
export function skipReason(type: RestPostType): string | null {
  if (NON_CONTENT.has(type.slug)) return "not-content";
  // Measured: `wp_font_face`'s rest_base is
  // `font-families/(?P<font_family_id>[\d]+)/font-faces` — a sub-resource route, not a
  // collection. It is already skipped as non-content; this catches the next plugin that
  // registers one, rather than building a URL containing a regex and getting a 404.
  if (TEMPLATED_REST_BASE.test(type.restBase)) return "templated-rest-base";
  return null;
}

export function contentPostTypes(types: readonly RestPostType[]): RestPostType[] {
  return types.filter((type) => skipReason(type) === null);
}

/**
 * The collection URL for one page of one post type.
 *
 * `per_page=100` is WordPress's maximum. `orderby=id&order=asc` is not cosmetic: the
 * default ordering is by date, so a post published between page 1 and page 2 shifts
 * every later item back one and pushes one item out of the enumeration entirely. `id`
 * ascending is stable under insertion. `_fields` cuts a 2,000-URL enumeration from
 * megabytes to kilobytes, and `page` is omitted at 1 so the first request is the one
 * WordPress's own `rel="next"` chain starts from.
 */
export function collectionUrl(host: string, type: RestPostType, page: number): string {
  const paged = page > 1 ? `&page=${page}` : "";
  return (
    `https://${host}/wp-json/${type.namespace}/${type.restBase}` +
    `?per_page=${PER_PAGE}&orderby=id&order=asc${paged}&_fields=id,link,type,status`
  );
}

/** WordPress's maximum `per_page`. Also what a full page of results looks like. */
export const PER_PAGE = 100;

export interface RestItem {
  readonly id: number;
  readonly link: string;
  readonly type: string;
  readonly status: string;
}

export interface RestCollectionPage {
  readonly items: readonly RestItem[];
  /** `X-WP-Total`, or null if the server did not say. */
  readonly declaredTotal: number | null;
  /**
   * `X-WP-TotalPages`. PRD §4 paginates by this; the resolver paginates by `hasNext`
   * instead, because the two can disagree — measured, page 6 of a 5-page collection is
   * a `400`, not an empty array — and the header is read so the disagreement is
   * visible rather than assumed away.
   */
  readonly declaredPages: number | null;
  /** Whether the server offered a `rel="next"`. */
  readonly hasNext: boolean;
}

/**
 * One collection page. Throws on anything that is not a readable page of items — a 401
 * on a type we are not allowed to read, or the `400 rest_post_invalid_page_number` that
 * a page past the end really returns. Neither may be read as "no more items": a
 * collection that stops early looks exactly like a smaller site, and a smaller
 * inventory reports fewer orphans (engineering guide §1).
 */
export function parseCollectionPage(
  response: Pick<HttpResponse, "status" | "headers" | "body">,
): RestCollectionPage {
  if (response.status !== 200) {
    throw new Error(
      `wp/v2 collection: HTTP ${response.status} ${response.body.slice(0, 200)}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(response.body);
  } catch {
    throw new Error(
      `wp/v2 collection: body is not JSON (${response.body.slice(0, 120)})`,
    );
  }
  if (!Array.isArray(json)) {
    throw new Error(`wp/v2 collection: expected an array of items`);
  }
  const items = json.map((entry, index) => {
    // Checked rather than cast, for the reason `parsePostTypes` gives: a `[null]` body
    // would otherwise throw a bare TypeError, and that message becomes the finding.
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`wp/v2 collection: item ${index} is not an object`);
    }
    const item = entry as Record<string, unknown>;
    const link = item["link"];
    if (typeof link !== "string" || link === "") {
      throw new Error(`wp/v2 collection: item ${index} has no link`);
    }
    return {
      id: typeof item["id"] === "number" ? item["id"] : index,
      link,
      type: typeof item["type"] === "string" ? item["type"] : "",
      status: typeof item["status"] === "string" ? item["status"] : "",
    };
  });
  return {
    items,
    declaredTotal: header(response.headers, "x-wp-total"),
    declaredPages: header(response.headers, "x-wp-totalpages"),
    hasNext: (response.headers["link"] ?? "").includes(`rel="next"`),
  };
}

function header(headers: Readonly<Record<string, string>>, name: string): number | null {
  const value = headers[name];
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
