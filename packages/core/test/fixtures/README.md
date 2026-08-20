# URL fixtures

Captured 2026-08-19 from live production sites at 1 req/s (PRD §5.1).

| File | What it is | What it proves |
|---|---|---|
| `sitemap-urls.txt` | Canonical URLs from `sitemap_index.xml` of integrity.com, tidewatermg.com, lionstreet.com, 403bplan.net. Deterministic every-Nth stride of 1,187 collected. | Normalization is a **no-op** on already-canonical URLs. Catches over-eager rules. |
| `raw-hrefs.txt` | Every unique `href` attribute from the four `pages/*.html` captures. | The messy real input: relative paths, `mailto:`, bare fragments, `&#038;` entities, uppercase paths, missing trailing slashes. |
| `pages/*.html` | Unmodified homepage responses. tidewater-home is GenerateBlocks; the rest are classic themes. | Step 2 link-extraction fixtures. |

Regenerate only when the estate changes shape — these are checked in so unit tests
never touch the network (engineering guide §4.2).
