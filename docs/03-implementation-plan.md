# link-graph — Implementation Plan

One buildable unit at a time. Each step below ends with a **runnable demo and a
passing test suite that needs nothing from later steps** (engineering guide §4.3).
No step exists to "prepare" for a later one; if a step has no demo, it is not a step.

Steps 1–7 deliver PRD §12 phase 1: crawl one site and print a trustworthy orphan
table. Steps 8–14 are the remaining PRD phases.

Sizes are relative (S ≈ half a day, M ≈ 1–2 days, L ≈ 3–5 days), not commitments.

---

## Step 0 — Toolchain — **done**

npm workspaces, TS strict + `noUncheckedIndexedAccess`, ESLint 9 type-aware,
Prettier, Vitest, `pretest` → lint. `packages/core` exists with `normalizeUrl` and
9 tests. See engineering guide §5.

---

## Step 1 — `core`: URL identity — S — **done**

**Why first.** PRD §13 names normalization bugs as the risk that manufactures fake
orphans and fake broken links. Every later number is a function of this one.

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| Package    | `packages/core` — `url.ts`                                         |
| Depends on | nothing                                                            |
| Seam       | `normalizeUrl(href, site, base?) → NormalizedUrl \| null` (exists) |
| Tests      | unit only                                                          |

**Finish the cases the current implementation does not cover:**

- trailing slash policy — one canonical form, applied to both sides of every compare
- `?p=123`, `?page_id=`, `/index.php`, `?replytocom=` (WP's own duplicate forms)
- default ports, percent-encoding case (`%2F` vs `%2f`), IDN/punycode
- protocol-relative `//host/path`, whitespace and newlines inside `href`
- `?s=` search URLs and paginated `/page/2/` — normalized, then _classified_ later

**Corpus test.** `census.json` holds per-site counts, not URL strings, so the corpus
was captured from live sitemaps and page HTML instead (`packages/core/test/fixtures`,
1 req/s, 2026-08-19). Two corpora, two different properties:

- **297 canonical sitemap URLs** — normalization must be a **no-op** on every one.
  This is the test that catches over-eager rules, and it caught two.
- **371 raw hrefs** from four real homepages — never throws, always idempotent,
  path always starts with exactly one slash.

Invented URLs do not count; the bugs live in real ones. Both rules that turned out to
be wrong were found by real data, not by the hand-written cases.

**Outcome on the 371 real hrefs:** 302 unchanged, 51 rewritten (mostly relative →
absolute), 17 null (10 `mailto:`/`tel:`/`javascript:`, 7 bare fragments).

**Two rules were too broad, and real data caught both:**

- **Trailing slash** was being applied to `/wp-json/` REST routes. Measured: those
  answer 200 slashed and unslashed and never redirect, so there is no canonical form
  to converge on. Now restricted to permalink space.
- **http → https** was being applied to external hosts. Justified for our estate
  (https-only behind CloudFront), unjustified for anyone else's TLS — and a
  broken-link report has to show the URL that was actually linked. Now internal only.

**Done.** 42 tests, lint clean.

---

## Step 2 — `core`: link extraction — S — **done**

Pure `html → links + head signals`. cheerio is a string→DOM parser with no I/O, so
it belongs in `core` (the one documented exception to §4.1).

|            |                                                                              |
| ---------- | ---------------------------------------------------------------------------- |
| Seam       | `extractPage(html, pageUrl, site) → { links: RawLink[]; head: HeadSignals }` |
| Depends on | step 1                                                                       |
| Tests      | unit, against saved real HTML                                                |

`RawLink`: normalized target, anchor text, `rel`, `nofollow`, DOM position.
`HeadSignals`: `<base href>`, canonical, `meta robots` / `X-Robots-Tag`, `<title>`.

**Fixtures are saved responses**, checked in: one Bricks page, one GenerateBlocks
page, one classic-theme page, one `noindex` page, one canonicalized duplicate. We
already know from the plugin investigation that page builders store content outside
`post_content` — these fixtures are how we prove the _rendered_ HTML is unaffected.

**Done.** 37 tests (79 total), lint clean. `extractPage(html, pageUrl, site)` returns
`{ links, head }`; entity decoding and `<base href>` resolution live here, as
`url.ts`'s contract requires.

**DOM position is `container` + `domIndex`, and `container` is the _outermost_ landmark
ancestor, not the nearest.** Measured on integrity-home: nearest collapses header 25 → 2
with 23 becoming `nav`, because every theme in this estate writes `<header><nav>` and
`<footer><nav>` — destroying exactly the distinction a boilerplate finding has to name
("only linked from the footer"). Outermost keeps `{header, main, footer}`. A closed
7-value vocabulary also `GROUP BY`s in SQL, which is what step 4 needs to calibrate N;
a CSS path would not aggregate and would churn on every theme release, breaking step 13.

**A parser, not a regex, and it matters.** A regex over the markup finds 24 `<a href>`
the parser does not: 14 inside a WS Form JavaScript string, 10 commented out. One of
those comments is `403bplan.net`'s only homepage link to `/newsletter-signup/` — a page
that **is** in the sitemap. A text-scraping extractor would report it as linked and hide
a real orphan.

**Two live defects found by reading real output, not by tests passing:**

- `tidewatermg.com` homepage carries `href="aging02.imgwebhost.com/resources/"` — a
  staging host with no scheme, so per RFC 3986 it resolves _inside_ the site to
  `/aging02.imgwebhost.com/resources/`. **Measured 2026-08-20, and not the 404 first
  assumed:** it 301s to `/resources/`, which is 200, while the intended host
  `aging02.imgwebhost.com` is NXDOMAIN. WordPress's canonical-guess redirect is
  rescuing a malformed link to a dead staging box — so it costs a hop, breaks if the
  `resources` slug ever moves, and is invisible to any check that only asks "did this
  return 200". This is the case PRD §13's redirect-awareness requirement exists for,
  and a plain status-code crawler would report the page as healthy.
- `403bplan.net/newsletter-signup/` is in the sitemap and its only homepage link is
  commented out. **Verified live 2026-08-20:** present in `page-sitemap.xml`, returns 200. A genuine orphan candidate, found as a side effect.

**Corrections:** `tidewater-home.html` is the **Bricks** theme (with GenerateBlocks also
loaded), not GenerateBlocks — the earlier label came from a detection script where the
last match overwrote the first. PRD §5.0's `.closest()` note was stale and is fixed.
`.prettierignore` now excludes `pages/`, since Prettier would silently reformat text
nodes these tests assert on byte-for-byte.

**Left undone, deliberately:** `X-Robots-Tag` is a response header, so it belongs to the
crawler in step 6; no `alt`/`aria-label` fallback for the 28 of 539 empty anchors (a
step-12 reporting decision); no foreign-canonical fixture — six probes found only
self-referential Yoast canonicals, and hunting one needs a broad crawl.

---

## Step 3 — `db`: schema, migrations, and a fixture loader — M — **done**

The first adapter, and the first thing that needs Docker.

|            |                                                          |
| ---------- | -------------------------------------------------------- |
| Package    | `packages/db`                                            |
| Depends on | nothing (schema only)                                    |
| Seam       | repository functions per table; `loadFixture(crawlJson)` |
| Tests      | `*.int.test.ts` against real Postgres                    |

Contents:

- PRD §7 tables as plain SQL migrations, forward-only, numbered files. No ORM — the
  analysis is SQL, and an ORM would only obscure it.
- A migration runner with a single test: run all migrations on an empty database
  twice; the second run is a no-op.
- **`loadFixture`** — reads a JSON crawl and writes `crawls`/`pages`/`links`. This is
  not a test helper bolted on; §4.3 requires that the API and the analyser be testable
  with no crawler present, and this is the only way that is true.
- `docker-compose.yml` containing **only Postgres**. The rest of the stack arrives
  when something needs it.

**Done.** 125 unit tests (no database needed) + 37 integration. Driver is `pg`, no
ORM. All eight PRD §7 tables, forward-only numbered migrations with sha256 checksums
that make an applied file immutable. Verified independently: first run applies 4
migrations, second applies 0.

**`links` carries two columns beyond PRD §7 — `container` and `dom_index` — and real
data proves `dom_index` is load-bearing, not decorative.** tidewatermg.com's homepage
links to one Google reviews URL **24 times from 24 distinct DOM positions**. A
`UNIQUE (crawl_id, from_page_id, to_url_normalized)` key — the obvious schema — would
have rejected a real production page.

**Measured on all six captures loaded end to end** (`extractPage` → fixture JSON →
tables): 4 sites, 4 crawls, 6 pages, 539 links, matching step 2's independently derived
count. `container` uses only **3 of its 7 values** (main 247, header 192, footer 100) —
step 4 should expect a sparse vocabulary. `depth`, `class` and `is_boilerplate` all load
as NULL, never a default, so step 4 cannot mistake "not yet computed" for "computed as
zero".

**`to_page_id IS NULL` is the common case, not the exception:** only **13 of 452**
internal edges resolve to a page in their own crawl, because 267 distinct internal
targets are uncrawled when the only crawled page is the homepage. Step 4's orphan maths
has to treat an unresolved target as "unknown", never as "missing".

**The fixture loader refuses rather than coerces.** Every URL must already be a
`normalizeUrl` fixed point; `path` and `isExternal` are derived and cannot be supplied;
unknown JSON keys are rejected. That is what makes it safe as step 4's and step 11's
only input.

**Flagged for later, deliberately not built:** no `pool.on("error")` handler and no
advisory lock in the migration runner — both verified to fail loudly rather than
silently, and both belong with step 10's worker concurrency. `crawl_metrics` cannot yet
express PRD §2's "undetectable" class; recorded as a comment in `004_metrics.sql` for
step 4. The pure derivation rules inside `parseCrawlFixture` are rules the crawler must
apply identically — they belong in `core` before step 6, or node identity splits.

---

## Step 4 — `analyse`: the orphan set difference — M — **done**

Built **before** the crawler, on purpose. Seeded from a fixture, the orphan maths can
be proven correct against a known answer — which is impossible when the input is a
live crawl whose correct answer nobody knows.

|            |                                                                           |
| ---------- | ------------------------------------------------------------------------- |
| Package    | `packages/analyse`                                                        |
| Depends on | step 3                                                                    |
| Seam       | `analyse(crawlId) → CrawlMetrics` — writes `pages.class`, `crawl_metrics` |
| Tests      | `*.int.test.ts`, fixture in / expected table out                          |

The four queries:

```sql
-- inbound edge counts
SELECT to_page_id, count(*) FILTER (WHERE NOT is_boilerplate) AS contextual,
       count(*) AS total
FROM links WHERE crawl_id = $1 AND NOT is_external GROUP BY to_page_id;

-- click depth from the homepage, over ALL internal links
WITH RECURSIVE d AS (...)   -- one depth, not two: see note below

-- boilerplate marking (PRD §6) — an edge appearing on > N% of pages
UPDATE links SET is_boilerplate = true WHERE to_url_normalized IN (...);

-- true orphans: in the truth source, includable, zero inbound internal edges
-- soft orphans: inbound edges exist, but every one of them is boilerplate
```

**One depth, over all internal links.** A page linked from global nav genuinely _is_
one click deep — a second contextual-only depth would answer a question that the
soft-orphan test already answers better, and adds a column nobody can explain.

**Decides PRD §15's boilerplate threshold N.** Start at 60%, then run the fixture and
two real crawls at 40/50/60/70/80 and pick from the data. Record the choice and the
evidence in the PRD.

**Done.** 144 unit + 57 integration tests. `analyse(pool, crawlId, opts)` writes
`pages.class`, `pages.depth`, `links.is_boilerplate` and one `crawl_metrics` row in a
single transaction. Graph maths is SQL; PRD §2's taxonomy is a pure, unit-tested
function; `analyse.ts` is wiring plus six refusals.

**Fixture is the whole of 403bplan.net** — all 13 sitemap URLs plus a planted `noindex`
`/?s=403b`, captured at 1 req/s. Verified output: 6 `linked`, **4 `orphan`**,
3 `soft_orphan`. The four orphans have zero inbound edges and NULL depth, and were
re-fetched live at 200.

**It found a contradiction in PRD §2 rather than papering over it** — see §2. One of the
three soft orphans is a false positive of the rule as written. The agent implemented the
PRD's operative rule and reported the conflict instead of inventing a third rule, which
is the correct behaviour.

**`crawl_metrics` makes `orphans`/`soft_orphans` nullable** — NULL, never 0, when a site
has no truth source, with a CHECK keeping them null together. That is PRD §2's
Undetectable class made unrepresentable-as-zero rather than merely documented.

**A §1 hole `analyse` cannot close alone:** the four step-3 captures report `orphans: 0`
for sites with 1,953 and 989 sitemap URLs, because nothing records how large the truth
source was. A one-page crawl of integrity.com looks like a clean bill of health. Step 5
must write a truth-source count onto `crawls`, and `analyse` must refuse when a crawl
covers materially less of it.

**Boilerplate is vacuous on tiny crawls:** at one page, every pair is on 100% of pages,
so integrity.com and lionstreet.com come out 58/58 and 25/25 boilerplate. N is a
parameter defaulting to 60 and stored per row; **not calibrated, and nothing written to
the PRD.** Single-site evidence is strong but narrow — the pair-frequency distribution on
403bplan.net is strictly bimodal (34 pairs at 1/13, 11 at 2/13, 12 at 13/13, nothing
between), so every N from 10 to 99 gives the identical answer. Estate-wide calibration
waits for step 7.

**Depth needed a real algorithm.** The naive `(id, depth)` `UNION` recursive CTE never
stops finding new rows on a nav-linked graph and ran its full 32-level ceiling in 11.8s;
a frontier-array form stops at the true diameter in 3.3s and needs no ceiling. At PRD
§7's scale the whole pass is ~21s, ~13s of which is writing 600k rows rather than
deciding what to write.

**Self-links are not inbound links** — a page cannot be reached from itself. This
refines §2's wording and only ever enlarges the orphan set. Boilerplate _frequency_
still counts them, since that measures appearances.

**Incidental real finding:** `/test-pay-button/` is a live, sitemapped orphan on
403bplan.net — a leftover test page.

---

## Step 5 — `truth`: the CMS side — M

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| Package    | `packages/truth`                                                   |
| Depends on | step 1                                                             |
| Seam       | `resolveTruthSource(site, deps) → { kind, urls, postTypes }`       |
| Tests      | unit with recorded fixtures; one `.int.test.ts` against live sites |

Order of preference, per PRD §4:

1. **WP REST** — `/wp-json/wp/v2/types` to enumerate post types dynamically, then
   paginate each. This is what pw-template's hardcoded `postType` misses, and why
   integrity.com's 477 blog entries and 400 team members are invisible today.
2. **Sitemap index** → child sitemaps.
3. **Neither** — `truth_source = 'none'`. The site is still crawlable for broken
   links and structure, and **must never report "0 orphans"** (PRD §13).

**Cross-check, not fallback.** When both exist, compare counts and flag disagreement.
`agent.familyfirstlife.com` returns exactly 2,000 sitemap URLs — a truncation
artifact that only a REST cross-check can catch.

**Done when** the three census cohorts each resolve correctly: a REST site, a
sitemap-only site, and one of the 47 with neither.

---

## Step 6 — `crawl`: the crawler — L

|            |                                                                      |
| ---------- | -------------------------------------------------------------------- |
| Package    | `packages/crawl`                                                     |
| Depends on | steps 1, 2, 3                                                        |
| Seam       | `crawl(site, seeds) → Promise<{ pages, links }>` (PRD §5.0)          |
| Tests      | unit with a fake fetcher; integration against a local fixture server |

undici + bottleneck + a Postgres frontier (PRD §5.0). What has to be true:

- **1 req/s default per host**, concurrent across hosts — Wordfence is per-host, so
  breadth is nearly free while depth is not.
- **First 503 stops that host**, records `was_throttled`, and resumes later. Measured:
  the ban is one hour, not five minutes.
- **Resumable frontier in Postgres.** A killed worker must not restart a 1,953-page
  crawl. This is a measured need, not speculation (engineering guide §2.1).
- **A failure is never a success.** Under engineering guide §1, a crawl that ends
  early exits non-zero and its `crawls` row is `status = 'partial'` — never a silent
  short page list, which is exactly the bug pw-template shipped.

**Integration tests run against a local fixture HTTP server**, never the estate: a
redirect chain, a 404, a canonical loop, a rate-limit 503 that recovers, a page whose
links point at aliases. Deterministic, offline, and it can assert the backoff.

**Done when** the fixture server crawl is byte-identical across runs and the
kill-and-resume test completes with the same page set.

---

## Step 7 — CLI: PRD phase 1 complete — S

`link-graph crawl <site-id>` → truth source → crawl → analyse → print the orphan
table. One command, one site, no queue, no UI.

**This is the first point at which the project is useful**, and the first point at
which the central claim is testable: run it on integrity.com and manually verify
every reported orphan. PRD §13 requires measuring the false-positive rate here,
before anything is built on top. If FP rate is not near zero, stop and fix step 4.

**Done when** a real orphan list for a real site survives manual review.

---

## Step 8 — `linkcheck`: lychee — M

Vendored static binary as a subprocess over external URLs due for a check (PRD §6.1).
Shared `external_urls` table with a TTL, so a destination linked from 40 sites is
fetched once. Integration test against the fixture server; `unverified` for hosts that
block us, never a false "broken".

## Step 9 — `registry`: liveness — S

Shallow-clone deployment-configurations, parse `ingress.entries[].hosts[].hostname`,
read `image.tag` for release attribution. Liveness probe per PRD §3.1. First real
output: the coverage-drift report — deployed but unmonitored, and configured but dead
(`agents.integrity.com` has no DNS; `integritymedicarehelpline.com` refuses
connections).

## Step 10 — `scheduler` + queues — M

Redis, three queues, one worker image. Weekly full crawl per site. **Jenkins does
nothing** (PRD §8). Compose grows to its full shape here — the first step where it has
to.

## Step 11 — `api` — M

Read-only over Postgres. Tested by seeding with `loadFixture` and asserting responses.
No crawler in the test path.

## Step 12 — `web` (Astro) — L

Tables first (orphans, soft orphans, broken links by blast radius), then treemap, then
distribution charts on TanStack Charts. Both audiences, one data layer, two vocabularies
(PRD §9). No node-link graph in this step.

## Step 13 — diffs, history, notifications — M

`crawl_diffs` between consecutive crawls, stamped with `deployed_tag`. Retention: link
detail for 12 crawls, then roll up to `crawl_metrics`.

## Step 14 — ego network; staging — M

Node-link at ~50 nodes, 1–2 hops, plain SVG, as a drill-down. Staging becomes a config
flag on the existing crawl path.

---

## Decisions this plan forces, and when

| Open item (PRD §15)                                   | Decided at | By what                                          |
| ----------------------------------------------------- | ---------- | ------------------------------------------------ |
| Boilerplate threshold N                               | step 4     | fixture + two real crawls at 40–80%              |
| Orphan false-positive rate acceptable?                | step 7     | manual review of one real site                   |
| Are the ~23 sitemap-less real-looking hosts in scope? | step 5     | what `truth_source = 'none'` actually costs them |
| Safe sustained crawl rate                             | step 6     | crawl telemetry, not more probing                |
| 12-crawl retention                                    | step 13    | measured row counts by then                      |

## Ordering rules

1. **Pure before impure.** Steps 1–2 have no dependencies and decide every number.
2. **Analysis before acquisition.** Step 4 precedes step 6 so the maths is verified
   against a known answer.
3. **Infrastructure arrives when something needs it.** Postgres at step 3, Redis at
   step 10, Astro at step 12 — never earlier.
4. **No step depends on a later step's output.** If one appears to, the split is wrong.
