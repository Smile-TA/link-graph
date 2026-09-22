/**
 * PRD §9 item 3 — section→section matrix: aggregate link counts at a readable
 * altitude, rather than the page-to-page detail the treemap and tables already show.
 *
 * **Boilerplate-filtered, on purpose.** `is_boilerplate` was kept computed and stored
 * through step 5.5 specifically for this view (see the implementation plan's step 4
 * note): nav/footer links appear on nearly every page, so counting them would make
 * every cell in a real site's matrix look saturated, hiding the contextual structure
 * a reader wants ("does /blog/ actually link into /products/, or only through the
 * header"). Self-links are excluded for the same reason `listPageAnalysisFacts`
 * excludes them — a page cannot reach itself.
 */
import type { LinkRow, PageRow } from "@link-graph/db";

/** The top-level path segment a page belongs to, `/` for the homepage. */
export function sectionOf(path: string): string {
  const segment = path.split("/").find((part) => part !== "");
  return segment === undefined ? "/" : `/${segment}/`;
}

export interface SectionMatrix {
  /** Every section with at least one crawled page, `/` first, then alphabetical. */
  readonly sections: readonly string[];
  /** `counts[from][to]` — contextual internal edges from section `from` to `to`. */
  readonly counts: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

export function buildSectionMatrix(
  pages: readonly PageRow[],
  links: readonly LinkRow[],
): SectionMatrix {
  const sectionByPageId = new Map(pages.map((page) => [page.id, sectionOf(page.path)]));
  const sections = [...new Set(sectionByPageId.values())].sort((a, b) =>
    a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b),
  );

  const counts = new Map<string, Map<string, number>>(
    sections.map((from) => [from, new Map(sections.map((to) => [to, 0]))]),
  );

  for (const link of links) {
    if (link.isExternal || link.isBoilerplate !== false || link.toPageId === null)
      continue;
    if (link.fromPageId === link.toPageId) continue;
    const from = sectionByPageId.get(link.fromPageId);
    const to = sectionByPageId.get(link.toPageId);
    if (from === undefined || to === undefined) continue;
    const row = counts.get(from)!;
    row.set(to, (row.get(to) ?? 0) + 1);
  }

  return { sections, counts };
}
