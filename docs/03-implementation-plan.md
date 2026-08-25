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

## Step 5 — `truth`: the CMS side — M — **done**

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

**Done.** 220 unit + 73 integration tests. `resolveTruthSource(site, deps, opts)` returns
`{ kind, urls, postTypes, counts, findings, requests }` over 31 recorded production
responses, so unit tests never touch the network. `kind` gained a fourth value,
**`unreachable`** — a throttled or dead host must never be filed as "no truth source",
because those are different facts with different remedies.

**It found that the estate is ~4× its recorded size.** See PRD §1. `census.json` recorded
2,000 URLs for `agent.familyfirstlife.com`; the real figure is **59,363**, verified two
independent ways. That one host is then 78% of the estate.

**The §1 hole from step 4 is closed.** New migration `006_truth_source.sql` stores the
inventory size on `crawls`, and `analyse` refuses a crawl that covers too little of it.
Verified: all four one-page captures now refuse, integrity.com's saying _"page rows for 1
of the 1953 URL(s) in its truth source (0.051%)… every count from this crawl understates
the site"_. The rule is a pure function, unit-tested with no database.

Coverage threshold is **90 and a parameter, not a measured constant** — the only complete
crawl in existence is 13/13, and the failure being caught is 1/1953. Recalibrate at
step 7.

**`sitemap-invisible` is answered as arithmetic, not a column.** `|REST \ sitemap|` falls
out of three stored counts, so nothing can drift, and the answer is NULL rather than 0
when only one source was read. It deliberately did **not** go into `pages.class`: that
column answers the orphan question, sitemap-invisibility is an orthogonal axis, and a
page can be both — so assigning it there would hide an orphan. Measured population: 28
published pages on integrity.com, one of which (`/news/`) returns 200, self-canonical, no
`noindex` — §2's misconfiguration case rather than intent.

**The sharpest §1 case found so far:**
`agent.familyfirstlife.com/wp-sitemap-posts-page-30.xml` answers **HTTP 404 with a valid
161 KB `<urlset>` of 1,363 real URLs** that REST independently confirms. A status-code-driven
resolver silently drops 1,363 pages. Hence the rule: **content decides, status is recorded.**

**Two rules that looked obviously right and cannot be implemented:** `viewable` is absent
from an unauthenticated `/wp/v2/types` (it is `edit`-context only), and `/wp/v2/blocks`
answers `200 []` while `menu-items` and `templates` answer 401 — so neither "enumerate the
viewable types" nor "the internal ones refuse" exists. What remains is WordPress's own
nine non-content types, identical across all four sites measured.

**Every reachable WordPress host probed exposes WP REST — 7 of 7**, including every
sitemapped one. PRD §4's sitemap-only branch may have no live cohort member as a _primary_
source; on this estate the sitemap's value is the cross-check. That branch is covered by a
documented plant, and the test says so.

**Left undone:** `findings` has no persistence sink — the nine degradations are computed and
returned but nothing stores them, because a findings table is a reporting-layer design
(step 12/13). No caller yet; step 7's CLI is the seam's first consumer. An unfetched
`in_truth_source` page still classifies `orphan`, which is now sharper because the coverage
gate tolerates up to 10% unfetched — that needs a step-4 decision.

---

## Step 5.5 — spec alignment: drop `soft_orphan`, add sampled scope — S — **done**

Not a feature. The two decisions recorded in `0236a6e` (PRD §2, §15) were written as
spec "before any code changes", and the code still implements the old rules: `analyse`
assigns `soft_orphan`, `crawl_metrics.soft_orphans` is a stored column, and there is no
way to express a sampled crawl at all. Step 6 would otherwise be built against a schema
its own spec already calls wrong.

|            |                                                            |
| ---------- | ---------------------------------------------------------- |
| Packages   | `packages/db`, `packages/analyse`                          |
| Depends on | steps 3, 4, 5                                              |
| Seam       | unchanged — `analyse(pool, crawlId, opts)`, same call site |
| Tests      | unit for both rules; `*.int.test.ts` for the migrations    |

**Why it is its own step rather than the first half of step 6.** It changes step 4's
committed behaviour, which the loop contract makes a hard stop for a subagent — the call
is the user's and was already made. Bundling it into the crawler would also hide a
schema change inside an L-sized step, and the migration is forward-only: once applied it
cannot be edited.

### 1. `soft_orphan` comes out

`pages.class` loses the value and `crawl_metrics` loses the column. The migration is
lossless rather than destructive: a page classified `soft_orphan` had inbound edges by
definition, so under the new rule it is exactly `linked`, and the `UPDATE` says so.

`classifyPage`'s final test becomes `inboundTotal > 0 → linked`, which makes
`inboundContextual` dead — it comes out of `PageFacts` and out of
`listPageAnalysisFacts`. `is_boilerplate` stays computed and stored for PRD §9's section
matrix, and the "no link left unmarked" refusal in `analyse` stays, but its reason
changes: an unmarked edge can no longer manufacture a class, so it is now an integrity
check on the boilerplate pass rather than a guard on the taxonomy.

`boilerplate_threshold_pct` stays on `crawl_metrics`. It is no longer the N that a
class depends on — it is the N a stored `is_boilerplate` was computed at, and a row
without it still cannot be compared with the next one.

### 2. Sampling becomes its own axis

PRD §15 says `crawler_mode = 'sample'`. `crawler_mode` is _which fetcher_
(`http`/`playwright`) and sampling is _how much of the site_ — one column cannot carry
both, and a third value would make "sample a Playwright site" unrepresentable. **Decided
2026-08-24: a separate `crawl_scope`**, and §15 is amended to match.

```sql
crawler_mode    CHECK (crawler_mode IN ('http', 'playwright'))     -- unchanged
crawl_scope     NOT NULL DEFAULT 'full' CHECK (crawl_scope IN ('full', 'sample'))
sample_ceiling  integer CHECK (sample_ceiling > 0)
CHECK ((crawl_scope = 'sample') = (sample_ceiling IS NOT NULL))
```

The paired CHECK is the point: `sample` with no ceiling is a full crawl wearing the
label, and a ceiling on a `full` site is a limit nothing enforces. Neither can be
written down.

### 3. `orphans IS NULL` gains a reason

Two different facts now produce a NULL orphan count — "this site has no truth source"
(PRD §2, Undetectable) and "this crawl was a sample by policy" (§15) — and they have
different remedies. A shared NULL that cannot say which is engineering guide §1's
failure in miniature, so `crawl_metrics.orphans_unknown_reason` carries the vocabulary
and a CHECK ties it to the column: `(orphans IS NULL) = (orphans_unknown_reason IS NOT
NULL)`. There is no third state to forget. `soft_orphans`' old pairing CHECK is dropped
with the column.

### 4. Per-page, a sample cannot answer the orphan question either

The decision as written is about `crawl_metrics`, but `analyse` also writes
`pages.class`, and step 12's tables read it. On a sampled crawl a truth-source page with
zero inbound edges is overwhelmingly likely to be linked from a page the sample never
fetched — so classifying it `orphan` would put false positives in front of a reader
while the crawl-level count honestly said "unknown". The taxonomy therefore ends:

```
inboundTotal > 0        → linked        (positive evidence, valid on a sample)
sampled, no inbound     → undetectable  (absence of edges proves nothing here)
otherwise               → orphan
```

`linked` is provable from one edge; `orphan` requires proving absence, which is exactly
what a sample cannot do. The reason is not repeated per page — it is a property of the
crawl and lives once, on `crawl_metrics`.

### 5. The coverage gate recognises the scope

Step 5's gate refuses a crawl covering less than 90% of its truth source, which a sample
never will — it would refuse forever. For `crawl_scope = 'sample'` the gate does not run:
the protection it provides is already provided, and more directly, by the orphan count
being NULL with a stated reason. The shortfall is deliberate, so it is not a failure.

**Done when** no `soft_orphan` survives anywhere in the tree, a sampled fixture crawl
loads and analyses to `orphans: null` / `orphans_unknown_reason: 'sampled'` without the
coverage gate firing, and the 403bplan.net fixture's four true orphans are unchanged —
that last one is the regression test that the drop touched nothing it should not.

**Done.** 230 unit + 79 integration tests, lint and Prettier clean. Migrations
`007_drop_soft_orphan.sql` and `008_sample_scope.sql`. `soft_orphan` survives nowhere:
not in the vocabulary, the CHECK, `crawl_metrics`, or the taxonomy.

**The 403bplan.net table moved exactly where predicted and nowhere else.** The three soft
orphans became `linked` (6 → 9) and **the four true orphans are untouched**, with the
same NULL depths — the regression this step existed to protect.

**The migration's lossless claim is tested, not asserted.** A fresh migration run has no
`soft_orphan` row to reclassify, so the test builds the database in two halves: the real
files up to `006` byte-for-byte into a temp directory, a `soft_orphan` page and a true
`orphan` page written under the old vocabulary, then the real directory — which applies
exactly `007` and `008` and nothing else. `/contact-us/` comes out `linked`,
`/newsletters/` stays `orphan`, and writing the value back is refused.

**Measured while writing the "N cannot move a class" test:** at N = 99, 184 of 240 edges
are still boilerplate, not 0. The 12 site-wide `(target, anchor)` pairs sit on 13 of 13
pages — exactly 100%, which is still _more than_ 99% — so the test's upper run uses 100.
That is the same bimodal distribution step 4 recorded, seen from the other end.

**The sampled path is proven on the crawl that exposed the hole it replaces.** The
integrity.com capture — 1 page of a 1,953-URL inventory — is still refused as a full
crawl and now analyses as a sampled one to `orphans: null` /
`orphans_unknown_reason: 'sampled'`. Same bytes, different policy, and no zero either
way. Sampled 403bplan.net gives 9 `linked` and 4 `undetectable`, never an `orphan`:
`classifyPage` writes `orphan` only when `orphansUnknownReason` is null, so the page list
and the count cannot disagree.

**Reported, not fixed: `unreachable` is still a plain count on a sampled crawl.** PRD
§15 keeps structure checked on the sample, so the number is computed — but a page can be
depth-NULL there only because the crawl never fetched the page linking to it. It is a
statement about the sampled graph, not the site, and now says so where it is defined.
Whether it needs the same NULL-with-a-reason treatment as `orphans` is a step-12
reporting decision.

**Left undone, deliberately:** nothing enforces that a `sample_ceiling` is actually
smaller than the inventory, so a "sampled" site with a ceiling above its page count
suppresses an orphan count it could have produced. That is a crawler-policy check and it
belongs with step 6, which is the thing that reads the ceiling. `orphansUnknownReason`
has no reporting surface yet — step 7's CLI is its first reader.

---

## Step 6 — `crawl`: the crawler — L — **done**

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

**Done.** 291 unit + 102 integration tests (230/79 before), lint and Prettier clean.
`crawl(pool, site, seeds, deps?)` and `resumeCrawl(pool, crawlId, deps?)` over
`packages/crawl` and migration `009_frontier.sql`. Pure rules in `record.ts`, `target.ts`,
`throttle.ts`, `seeds.ts`, `sample.ts` and `verdict.ts`; I/O in `fetcher.ts`,
`limiter.ts`, `write-page.ts`; `crawl.ts` is the loop and the refusals.

**A partial crawl is thrown, not returned.** `PartialCrawlError` carries the result, so a
caller that ignores the outcome gets an unhandled rejection and a non-zero exit with no
CLI in the picture, and `crawls.status = 'partial'` makes `analyse` refuse it. A returned
`{ status: 'partial' }` is a value someone can forget to read, which is the pw-template
bug in a new costume.

**Both done-criteria are met on the real 13 pages.** The fixture server serves the
checked-in 403bplan.net captures and the crawl produces **13 pages and 240 links — the
figures step 4 derived by hand from the same bytes**, byte-identical across runs (a full
row-by-row snapshot, identity columns excluded, so a new column joins the comparison
rather than escaping it). Kill-and-resume: killed after 6 requests, the row stays
`running` with 7 pending, the resume makes 7 more requests for 13 distinct total, and its
snapshot equals an uninterrupted run's.

**The 503 path is exercised end to end and does not sleep.** First 503 stops the host,
`retry_after: 3600` is surfaced, the run is `partial` in under 5s of wall clock, the
blocked URL keeps **no page row** — a 503 describes our request rate, not the page, and
storing it would file a live page as broken — and the resume completes the crawl with
`was_throttled` still true. Throttling that happened stays recorded even when a later run
finishes.

**Measured, and it refines PRD §5.0: undici's process-global dispatcher costs ~200ms per
request when the request is issued inside a `bottleneck` task.** 10 sequential requests:
2.0s global, 75ms through an owned `Agent`, same single TCP connection, order-independent
— and outside a bottleneck task both are fast. The combination is the bug. Eight minutes
of a 33-hour crawl, invisible. §5.0 now says the pool must be held explicitly.

**Two rules that could not be fixtured, and both are reported rather than faked.** A
two-node canonical loop does not exist on this estate (step 2 found only self-referential
Yoast canonicals in six probes), and the crawler never reads a canonical as a traversal
input, so the loop is unreachable by construction — the test proves that against the real
canonicalized duplicate instead of inventing markup. And `headerNoindex` initially
disagreed with `extractPage` about `noindex`: core splits directives on whitespace _and_
commas because Google reads `content="noindex nofollow"`, the header parser split on
commas only, so the same directive in a header would have left the page orphan-eligible.
Found by comparing the two, fixed, tested.

**The `sample_ceiling` check step 5.5 left open is done here**, where the ceiling is
actually read: a `sample` site whose ceiling is not smaller than its inventory is refused,
because it would cover the whole site and still report `orphans: null` for the reason
`sampled` — suppressing a count it could have produced. Not compared when the site has no
inventory: there is no number, and refusing on that basis would be an invented rule.

**Left undone, deliberately:** robots.txt — PRD §5.0 lists `robots-parser`, this step's
contract does not, this is our own estate, and honouring a `Disallow` would _manufacture_
orphans by hiding pages from the graph; `retry-after` has no persistence sink (step 10's
scheduler is what would sleep on it); `pages.post_type` stays null; internal document
links are recorded as edges and never fetched, landing in `internal_unresolved` where
step 8's lychee will check them; no `FOR UPDATE SKIP LOCKED` on the frontier (one worker
per crawl until step 10); a sampled crawl still queues URLs it will never fetch, on
purpose — the frontier is the only record of what the sample skipped.

**Three duplications now at the threshold where the guide says lift them**, all left in
place with the duplication named in comments, because each edits a committed earlier step:
`homepageUrl` (second copy, the first in `packages/analyse`), the file-extension primitive
shared with `core/url.ts`, and the `SiteRow → SiteHosts` projection now written five
times. The 403bplan fixture manifest is a third copy of the 13-row URL→file table — the
97 KB bodies are read in place, not copied.

---

## Step 7 — CLI: PRD phase 1 complete — S — **built, verification pending**

`link-graph crawl <site-id>` → truth source → crawl → analyse → print the orphan
table. One command, one site, no queue, no UI.

**This is the first point at which the project is useful**, and the first point at
which the central claim is testable: run it on integrity.com and manually verify
every reported orphan. PRD §13 requires measuring the false-positive rate here,
before anything is built on top. If FP rate is not near zero, stop and fix step 4.

**Done when** a real orphan list for a real site survives manual review.

**Half done, and deliberately stopped there.** 334 unit + 113 integration tests
(291/102 before), lint and Prettier clean. `packages/cli` gives
`link-graph crawl <site-id>`: registry row → `resolveTruthSource` → `crawl` → `analyse`
→ the orphan table, with `runCrawlCommand(pool, siteId, progress, deps)` and
`main(argv, io, deps) → exit code` as its seams.

**The command reproduces step 4's hand-derived table through an independent path** — 13
pages, 240 links, 9 linked, 4 orphans, the same four URLs, 17 internal unresolved, 23
external — reached by resolving truth over HTTP and crawling, not by loading a fixture
JSON. Its own happy-path test guessed the fourth orphan wrong and the command was right.

**The exit code is the contract, because it is the only part a cron job reads.** 0 the
question was answered; 1 usage/registry, nothing crawled; 2 the run failed and printed
no numbers; 3 the crawl finished and the orphan count is unknown. **3 covers `sampled`
too** — deliberate or not, it is not an answer, and a caller reading only the code must
not record it as one.

**What is NOT done is the half that matters: the live run and the false-positive
measurement.** PRD §13 makes it the gate before anything is built on top, and the loop
contract makes a live crawl a hard stop for a subagent. The step stays open until a real
orphan list for a real site survives manual review — which is a decision about which site
to crawl and whose time reviews it.

**Blocked on that same decision, and pre-scoped:** `--boilerplate-threshold` and
`--min-coverage` flags. Both `analyse` options name step 7 as their calibration point and
neither can be calibrated without the live crawl, so the flags are ten lines at
`run.ts:86` the moment the run is green-lit.

**A §1-shaped gap found and left pinned rather than patched — see PRD §15.** A truth
resolution that loses one of its two sources still exits 0 and differences against the
smaller view. It is printed as a finding under a heading naming the consequence, and an
integration test pins today's behaviour so that changing it is a decision rather than an
accident.

**Left undone:** no `resume` subcommand, so every retry after a `PartialCrawlError`
re-fetches the site — the most valuable next addition, and it needs `resumeCrawl` reachable
from the CLI. Nothing creates a `sites` row: the command refuses an unknown site with a
`UsageError` naming step 9, and real use needs either step 9 or a one-off insert.
`pool.on("error")` covers idle clients only — a connection lost inside a transaction still
exits 1, and closing that needs a listener in `withTransaction` (step 3's committed code),
deferred to step 10.

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
