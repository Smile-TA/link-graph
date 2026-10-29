/**
 * Which discovered URLs the crawl fetches — its **URL-admission policy**.
 *
 * PRD §2 records that this policy is not a detail: adding 403bplan.net's 17 internal
 * PDF links to a crawl of its 13 pages moved the boilerplate denominator from 13 to 30
 * and flipped every soft orphan on the site to `linked`. The class it moved has since
 * been dropped, but the lesson stands — what the crawler chooses to fetch changes what
 * the analysis says, so the choice is written down here with its reasons rather than
 * being an accident of the frontier.
 *
 * **The rule: a page has no file extension, or an extension that serves HTML.** Measured
 * on the checked-in 403bplan.net captures: the site's 26 distinct internal targets are
 * 9 pages and 17 PDF uploads, and no page of it carries an extension — WordPress
 * permalinks are extensionless and `normalizeUrl` gives them a trailing slash.
 *
 * **What this gives up, deliberately.** A broken internal link to a document is not
 * detected here. It is not lost either: with no page row for the target, `analyse`
 * counts the edge in `internal_unresolved` — "nobody checked" — which
 * `005_analysis.sql` exists to keep out of `broken = 0`. Link *verification* is PRD
 * §6.1 and step 8's job. Fetching them instead would spend a real share of a 1 req/s
 * budget downloading prospectuses (one of these is 129 pages) to learn a status code
 * that a link checker gets for the same cost without a `pages` row.
 */

/** Extensions that serve a document we would parse for links. */
const PAGE_EXTENSIONS = new Set(["html", "htm", "php"]);

/**
 * Query parameters that turn a page URL into a calendar export or a calendar view, not a
 * page. The Events Calendar plugin serves `?ical=1` as `text/calendar` on some sites and
 * as a zero-length `200 text/html` on others (measured 2026-10-27: neishloss.com and
 * medicareacademy.com), and its date navigation (`tribe-bar-date`, `eventDate`,
 * `eventDisplay`, `post_type=tribe_events`) mints a new URL for every day and month, each
 * linking to more of them. Measured 2026-10-28 on saversmarketing.com: a 60-URL truth
 * source, 5,050 pages fetched and still 1,196 pending, 99% of them these. None is a node
 * a link graph has.
 */
const EXPORT_PARAMS =
  /[?&](?:(?:outlook-)?ical|tribe-bar-date|eventDate|eventDisplay)=|[?&]post_type=tribe_events(?:&|$)/i;

/**
 * The same calendar views when the plugin uses pretty permalinks: `/events/2026-10-26/`,
 * `/events/month/2026-10/`, `/event-calendar/week/2026-10-14/`,
 * `/events/tag/<tag>/day/2026-10-26/` (the first segment is any that contains "event"). Every tag and category
 * repeats every date, so the space is unbounded. Measured 2026-10-28 on pipac.com: a
 * 792-URL truth source, 3,025 pages fetched and 1,375 still pending, 1,884 of them these.
 */
const EVENT_DATE_PATH =
  /^\/[^/?]*event[^/?]*\/(?:[^?]*\/)?(?:(?:day|week|month)\/)?\d{4}-\d{2}(?:-\d{2})?\/?(?:\?|$)/i;

/**
 * Whether a root-relative path (pathname plus query, as `NormalizedUrl.path` gives it)
 * names something this crawl should fetch.
 */
export function isCrawlableTarget(path: string): boolean {
  if (EXPORT_PARAMS.test(path) || EVENT_DATE_PATH.test(path)) return false;
  // The query is not part of the resource's name here: `/?s=403b` is a page and
  // `/a.pdf?v=2` is a PDF.
  const pathname = path.split("?")[0] ?? "";
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  // Same shape as core's LOOKS_LIKE_FILE, and deliberately so: that rule decides which
  // paths keep a trailing slash, and a path core treats as a filename must not be a
  // page here.
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(lastSegment)?.[1];
  return extension === undefined || PAGE_EXTENSIONS.has(extension.toLowerCase());
}
