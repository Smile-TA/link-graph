# URL and page fixtures

Captured from live production sites at 1 req/s (PRD §5.1). URL corpora and the four
homepages: 2026-08-19. The two extraction fixtures: 2026-08-20.

| File               | What it is                                                                                                                                                                | What it proves                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `sitemap-urls.txt` | Canonical URLs from `sitemap_index.xml` of integrity.com, tidewatermg.com, lionstreet.com, 403bplan.net. Deterministic every-Nth stride of 1,187 collected.               | Normalization is a **no-op** on already-canonical URLs. Catches over-eager rules.                                              |
| `raw-hrefs.txt`    | Unique `href` attributes from the four `pages/*-home.html` captures, assets aside — `<link rel=alternate>` hrefs included, not only anchors, and commented-out ones kept. | The messy real input: relative paths, `mailto:`, bare fragments, `&#038;` entities, uppercase paths, missing trailing slashes. |
| `pages/*.html`     | Unmodified responses.                                                                                                                                                     | Step 2 link-extraction fixtures.                                                                                               |

## `pages/`

| File                                     | Fetched as                                           | Why it is here                                                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403bplan-home.html`                     | `https://403bplan.net/`                              | Classic theme. Five anchors are commented out, one of them the only homepage link to `/newsletter-signup/` — the case that separates a parser from a regex.                       |
| `integrity-home.html`                    | `https://integrity.com/`                             | Classic theme, 58 links, 7 root-relative hrefs.                                                                                                                                   |
| `lionstreet-home.html`                   | `https://lionstreet.com/`                            | Classic theme, small enough for its whole link set to be asserted by hand.                                                                                                        |
| `tidewater-home.html`                    | `https://tidewatermg.com/`                           | **Bricks** theme (`wp-content/themes/bricks` + `bricks-child`) with the GenerateBlocks plugin also loaded. 346 links, 27 `nofollow`, seven `<a href>` inside a JavaScript string. |
| `tidewater-search-noindex.html`          | `https://tidewatermg.com/?s=medicare`                | `meta robots: noindex, follow` and **no canonical at all**. Also the one real `<a href>` in the estate carrying `&#038;`.                                                         |
| `403bplan-newsletter-canonicalized.html` | `https://403bplan.net/newsletter-signup/?ref=lgtest` | Canonical points somewhere other than the fetched URL — the query is dropped. The Excluded-class signal of PRD §2.                                                                |

**No page in this estate emits `<base href>`** (measured across all six captures), and
Yoast writes a self-referential canonical on every indexable page — a canonical
pointing at a _different_ page was only obtainable by fetching one with a query
string. `<base href>`, uppercase `meta robots` names and inline `<svg><title>` are
therefore covered by minimal inline documents in `extract.test.ts` rather than by a
fixture.

Regenerate only when the estate changes shape — these are checked in so unit tests
never touch the network (engineering guide §4.2).
