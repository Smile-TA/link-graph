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

## Step 7 — CLI: PRD phase 1 complete — S — **done; gate passed 2026-09-02**

`link-graph crawl <site-id>` → truth source → crawl → analyse → print the orphan
table. One command, one site, no queue, no UI.

**This is the first point at which the project is useful**, and the first point at
which the central claim is testable: run it on integrity.com and manually verify
every reported orphan. PRD §13 requires measuring the false-positive rate here,
before anything is built on top. If FP rate is not near zero, stop and fix step 4.

**Done when** a real orphan list for a real site survives manual review.

**Half done as of 2026-08-24, and deliberately stopped there — the other half closed
2026-09-02, see "The gate" below.** 334 unit + 113 integration tests
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

**Was blocked on that same decision, and pre-scoped (unblocked 2026-09-02):** `--boilerplate-threshold` and
`--min-coverage` flags. Both `analyse` options name step 7 as their calibration point and
neither can be calibrated without the live crawl, so the flags are ten lines at
`run.ts:86` the moment the run is green-lit.

**A §1-shaped gap found and left pinned rather than patched — see PRD §15.** A truth
resolution that loses one of its two sources still exits 0 and differences against the
smaller view. It is printed as a finding under a heading naming the consequence, and an
integration test pins today's behaviour so that changing it is a decision rather than an
accident.

### The gate, closed 2026-09-02 — **1.7% known false positives**

The last of the three blocking decisions landed (PRD §15): thank-you and campaign pages
are **findings**, not Excluded. That resolves the whole 538 into classes:

| Bucket                         | Count | Verdict                                      |
| ------------------------------ | ----: | -------------------------------------------- |
| `/partner/` archive            |   270 | true orphans, browser-verified               |
| `/inspire/` archive            |   210 | true orphans, browser-verified               |
| taxonomy archives              |     9 | **false** — Excluded by migration `010`      |
| form thank-you pages           |     8 | findings, correct as reported                |
| campaign / event landing pages |     8 | findings, correct as reported                |
| everything else                |    33 | findings — the leftovers the tool exists for |

**Known false positives: 9 of 538, 1.7%.** PRD §13's threshold is "near zero", so the
gate passes, and the plan's "if FP rate is not near zero, stop and fix step 4"
instruction never fires — which is correct, because step 4 was right all along.

**Two limits on that number, stated rather than rounded away.** The 480 were verified by
probing **5** pages of two homogeneous archive templates, so their reality is an inference
from a verified mechanism, not 480 independent measurements. And the 33 leftovers were
sorted by reading slugs — the same inference PRD §2 just declined to encode as an Excluded
rule — so they are counted as findings because that is the definition of an unreviewed
finding, not because each was confirmed actionable. The missing measurement in both cases
is a reader's judgement, and step 7.6 is where it goes.

**Still unproven end to end:** migration `010` is not applied to the local database and
`post_type` is NULL on every row of the 2026-08-25 crawl, so re-running `analyse` over it
would reclassify nothing. The nine archives are false positives by arithmetic; the chain
from `/wp/v2/types` through `crawl_frontier.post_type` into `pages` has only run against
fixtures. Closing that needs a re-crawl or a truth-source-only backfill, and it is a
verification debt on step 6's write path, not a reason to hold step 7 open.

**The two pre-scoped flags are now unblocked**: `--boilerplate-threshold` and
`--min-coverage`, ten lines at `run.ts:86`.

---

### Correction, 2026-08-26: **the verification below was wrong, and the tool was right**

The section that follows concluded ~89% of the 538 orphans were false, because the two
big buckets sit behind `admin-ajax` listings. **That inference was never tested, and it
does not survive testing.** Measured with the Playwright fetcher built the next day, on
the live pages:

- `/about-us/our-partners/` rendered in Chromium, stylesheets allowed, scrolled twice,
  6s of settling: **73 hrefs, exactly one containing `/partner/`** — the archive root.
  Zero `onclick` handlers. Partners open in a `modal team-modal partner` container.
- `/inspire/` and `/inspire/?sf_paged=16` render **identically**, and both yield **3**
  `/inspire/<slug>/` links, two of which are `page` and `feed` rather than items.
- The archive's **own declared results endpoint**, `?sf_data=results`, returns 91 KB
  containing **one** distinct item slug.

So the item links do not exist in the served HTML, in the rendered DOM, or in the
endpoint the page itself declares. **480 published, indexable, sitemapped pages have no
crawlable inbound link from anywhere on the site** — which is precisely what PRD §2
defines as a true orphan, and precisely what a search engine would conclude.

**The real false-positive rate is therefore about 5%, not 89%**: 9 taxonomy archives
(fixed by the Excluded-class work), ~10 form thank-you pages and ~8 campaign landing
pages — ~27 of 538 — and every one of those is a _classification_ question §15 already
tracks, not a wrong answer about the graph. **Step 7's gate looks like a pass**, pending
a decision on those three classes.

**How the error was made, since that is the reusable part.** The reasoning went: the
listing page serves few links → `admin-ajax` is present → therefore the links are
AJAX-rendered → therefore the orphans are false. Every step after the first was an
inference, and the engineering guide's own rule — verify an assumption about a server
before encoding it — was skipped precisely because the conclusion felt obvious. The
Playwright fetcher was then built to fix a problem that did not exist; it is still PRD
§5's designed capability and it is what disproved the premise, but it is **not** the
remedy for these 480 and nothing should describe it as such.

### The live verification, 2026-08-25 — **superseded by the correction above**

Ran `link-graph crawl integrity-com` against prod. **41.2 minutes, 2,454 pages, 127,845
links, `was_throttled = false`** — 2,454 requests at 1 req/s drew no 503, which is the
first real confirmation of PRD §5.1's default outside the 155-request probe. Truth source
`rest`, 2,001 URLs (REST 1,974, sitemap 1,959) in 43 requests. Exit 0.

**It reported 538 orphans — 27% of the inventory — and about 89% of them are false
positives.** PRD §13's threshold is "near zero", so this is a failure of the gate, and by
the plan's own rule nothing gets built on top until it is fixed.

**Two buckets are 480 of the 538, and both are the same root cause: links that do not
exist in server-rendered HTML.**

- **`/partner/…` — 270 orphans.** `/about-us/our-partners/` serves 70 KB containing
  **one** `/partner/` href and **zero** partner slugs anywhere, including inside JS
  payloads; `admin-ajax` appears 4 times. The whole 274-page partner directory is
  AJAX-loaded. Only 4 distinct `/partner/` URLs are linked from anywhere on the site.
- **`/inspire/…` — 210 orphans.** The crawler _did_ discover the archive's pagination
  (23 pages fetched, up to `?sf_paged=24`). But `/inspire/?sf_paged=16` serves 90 KB whose
  only 12 `inspire` links are **pagination links** — not one item. Search & Filter Pro
  (`searchandfilter`, `data-sf`, `admin-ajax`) renders the results client-side.

**PRD §5's opening claim needs qualifying.** "These are server-rendered WordPress sites,
so links are in the HTML" is true of article bodies and false of this estate's
directories and filtered archives. `crawler_mode = 'playwright'` was designed for exactly
this and has never been exercised; `CrawlFetcher` is already the seam, so it is a second
implementation of an existing interface rather than a redesign.

**Of the remaining 58, most are still not actionable findings:**

- **~10 taxonomy archives** (`/category/featured/`, `/insights_category/*`,
  `/wealth_category/*`, `/family_category/featured/`). PRD §2 already requires taxonomy
  archives to be Excluded and calls it phase-1 work; step 4 flagged it unbuilt. This is
  the second site to prove it, after tidewatermg.com's 164.
- **~10 form thank-you pages** (`/agents/thank-you/`, `/wealth/*/thank-you/`, …), unlinked
  by design and reached only after a submit.
- **~8 campaign landing pages** (`/nationaldogday/`, `/springtraining/`,
  `/valero-open-giveaway/`, …), reached from email and social rather than internal links.
- **~30 that look genuinely actionable**, including `/test/` and
  `/integrityconnect-ip-old/` — exactly the leftovers this tool exists to surface.

**The plan's attribution is wrong, and that is the most useful thing here.** This step
said "if FP rate is not near zero, stop and fix step 4". Step 4 is **correct**: every one
of those 538 pages genuinely has zero inbound internal edges in the crawl, and the maths
faithfully reports what the graph contains. The defects are **acquisition** (links that
need JS to exist) and **classification** (PRD §2's Excluded classes still unbuilt). A
"fix step 4" instruction would have sent the next iteration at the one component that is
behaving.

**The run delivered real value regardless, which is worth recording:** 58 broken internal
link **edges** over **18** distinct targets — corrected 2026-09-02, see step 7.6; the
finding count a person acts on is 18, and blast radii sum to 44 — led by `/integrityidol/`
(404, linked from **18** pages), plus a
malformed relative link resolving to
`/inspire/…/teammembers/katiry-gonzalez/` — the RFC 3986 class step 2 found on
tidewatermg.com, on a second site. The Excluded machinery works: 250 canonical-elsewhere,
90 redirect, 28 noindex, 18 status-404.

**Blocked on a decision (PRD §15):** whether to add the Playwright fetcher and build
§2's Excluded classes before re-measuring, and whether thank-you and campaign pages are
Excluded-by-intent or genuine findings a reader wants.

**Left undone:** no `resume` subcommand, so every retry after a `PartialCrawlError`
re-fetches the site — the most valuable next addition, and it needs `resumeCrawl` reachable
from the CLI. Nothing creates a `sites` row: the command refuses an unknown site with a
`UsageError` naming step 9, and real use needs either step 9 or a one-off insert.
`pool.on("error")` covers idle clients only — a connection lost inside a transaction still
exits 1, and closing that needs a listener in `withTransaction` (step 3's committed code),
deferred to step 10.

---

## Step 7.6 — `review`: the findings sink — S — **done**

**Why here.** Step 7's gate produced 529 correct findings on one site, and 16 of them are
correct-and-intentional. A reader who cannot say "I have judged this one" reads the same
list every week and stops reading it — which is PRD §2's opening sentence ("an orphan
report that is 30% noise gets ignored within two weeks") arriving through a different
door. It is the first thing the tool needs that step 7's own output proved it needs.

|            |                                                         |
| ---------- | ------------------------------------------------------- |
| Package    | `packages/review` + migration `011_finding_reviews.sql` |
| Depends on | steps 3, 4, 7                                           |
| Seam       | `reviewsFor(pool, siteId, kind) → Map<subject, Review>` |
| Spec       | PRD §7.1 — the five rules, all five testable            |
| Tests      | unit for digest + bucketing, integration for the table  |

**Demo.** `link-graph note integrity-com orphan /agents/thank-you/ --intentional -m
"reached after form submit"`, then `link-graph report integrity-com` shows the orphan
table split **new / changed since review / reviewed**, all three counts printed, the total
unchanged at 538.

**The tests that matter are the §1 ones**, and they are the reason this is a step rather
than a UI detail:

- reviewing every orphan on a site leaves `crawl_metrics.orphans` **byte-identical** and
  makes the report read "538 orphans, 538 reviewed" — never "no orphans", never 0
- a review survives the crawl its finding was recorded in being deleted, because it keys
  on `(site_id, kind, subject)`
- an `acknowledged` broken link whose blast radius moves 18 → 40 re-surfaces as changed;
  the same link re-crawled unchanged does not
- `state` and `kind` have no `fixed` value and the SQL `CHECK` refuses one

**Left out on purpose:** no `fixed` state (PRD §7.1 rule 4), no per-user auth —
`reviewed_by` is `--by` or `$USER`, and step 11 can tighten it — and no
disappeared-then-returned detection, which needs step 13's crawl history and is recorded
as §7.1's open gap.

---

**Built and verified 2026-09-02.** 429 unit + 152 integration (429/152 claimed, 429/152
re-run independently; baseline was 334/113), lint and Prettier clean. `evidenceDigest` /
`bucketFindings` / `reviewsFor` in `packages/review`, migration `011_finding_reviews.sql`,
`findLatestCompleteCrawl`, and `note` + `report` on the CLI. `crawl`'s behaviour and
`exit.ts`'s code table are unchanged — `exitCodeForSiteReport` maps the new shape onto the
existing table.

**Verified against the real 2,454-page crawl, not just fixtures.** Migrations `010` and
`011` were applied to the dev database (it had been sitting at `009`), and the demo ran
end to end: `report integrity-com` prints `Orphans 538 — 538 new`, one `note … orphan
/agents/thank-you/ --intentional` moves it to `537 new … 1 reviewed (1 intentional, 0
acknowledged)`, and **the total stays 538** with `crawl_metrics` reading `orphans=538
broken=58` throughout. `--fixed` exits 1 quoting rule 4.

**The four §1 tests were confirmed to bite by mutating the implementation**, rather than
taken on the subagent's word: dropping `blast_radius` from the digest fails 3 tests
including the pinned golden digest; filtering reviewed findings out of the set fails 5
including "keeps the measured total whole"; adding `fixed` to `REVIEW_STATES` fails the
refusal test (via the SQL CHECK — the layered defence holds).

**Three measurements re-run independently, all three confirmed:** `btrim(E'\t') = ''` is
**false** on postgres 18.6 — one-argument `btrim` strips spaces only, so the obvious
non-blank check would have accepted a tab-only note, and it would have been immutable once
applied; `ORDER BY … DESC` puts NULLs **first**, so `NULLS LAST` in
`findLatestCompleteCrawl` is load-bearing; and crawl 1 holds **58 broken edges over 18
targets with blast radii summing to 44**, which is the correction applied to step 7 above.

**`findLatestCompleteCrawl` filters `env = 'prod'`**, because every page of
`integrity-2024.staging02` is `noindex` (PRD §15), so a staging crawl reports
`orphans: 0, linked: 0` — letting one become "the site's last crawl" would print a clean
bill of health for a site nobody checked.

**Two gaps disclosed in the output rather than hidden**, both needing an earlier step's
data: `report` cannot reproduce `crawl`'s exit 3 for a provably short inventory, because
step 5's truth findings are stored nowhere — the report body says so in as many words;
and PRD §9's three-way split applies to `report`'s tables only, not `crawl`'s.

---

## Step 8 — `linkcheck`: lychee — M — **done; gates passed 2026-09-09**

Vendored static binary as a subprocess over external URLs due for a check (PRD §6.1).
Shared `external_urls` table with a TTL, so a destination linked from 40 sites is
fetched once. Integration test against the fixture server; `unverified` for hosts that
block us, never a false "broken".

## Step 9 — `registry`: liveness — S — **done**

Shallow-clone deployment-configurations, parse `ingress.entries[].hosts[].hostname`,
read `image.tag` for release attribution. Liveness probe per PRD §3.1. First real
output: the coverage-drift report — deployed but unmonitored, and configured but dead
(`agents.integrity.com` has no DNS; `integritymedicarehelpline.com` refuses
connections).

**Done.** 526 unit tests (524 before this step's fix, up from 519 pre-step-9) + 170
integration, lint and Prettier clean. `packages/registry` — `deriveSites`,
`mergeRegistry`, `probeLiveness`, `classifyDrift`, `syncRegistry` — plus `listSites` in
`packages/db` and `registry sync` / `registry report` on the CLI. No new migration:
`001_sites.sql`'s `sites` and `registry_health` tables already held everything this step
needed to write.

**A real clone, not a fixture.** `git clone --depth=1` against the live
`deployment-configurations` (SHA `55c0457…`) found **199** app directories, **195** with
a prod `values.yaml`, **163** carrying at least one prod hostname across **307**
hostnames on **140** multi-host apps — close to, and visibly drifted from, PRD §3's
2026-08-18 figures (312/145/143), which is the estate moving, not a measurement error.
The 36 apps with zero prod hostnames split cleanly into variant directories (`-v2`,
dated, `-traefik-canary`) and platform utilities (backup/restore, vault, Wordfence
tooling) — the curation overlay (`packages/registry/src/curation.json`) excludes exactly
these by app directory name, checked in and reviewed like code rather than mutated in a
table.

**`link-graph registry sync` run for real** against the dev database: 199 app
directories derived, 163 became sites rows (36 excluded by curation), all 163 probed, in
4m22s, exit 0. The liveness probe (PRD §3.1: DNS → serves → platform signature →
`/version.txt`) measured **157 dnsOk, 6 no-DNS, 152 serving, 106 with the full
Apache/2.4.68 + CloudFront signature, 133 with a real `/version.txt`** across all 163.

**The first coverage-drift report reproduces PRD §3.1's own two examples.**
`link-graph registry report`: **0 deployed-but-unmonitored, 57 configured-but-dead**,
and the 57 include `agents.integrity.com` (no DNS) and `integritymedicarehelpline.com`
(connection refused) by name — the exact pair the PRD cites, arrived at independently
through this step's own probe rather than copied from the document.

**DNS and HTTP are both injected** (`LivenessDeps`), so `liveness.test.ts`'s unit tests
run a fake resolver/fetcher; `sync.int.test.ts` re-probes **three** real hosts
(`403bplan.net`, `advisorsib.com`, `agentcore.com`) drawn from the real clone rather than
sweeping the whole estate in a test — this project's convention since step 6. All three
came back fully live with real `/version.txt` bodies.

**A real bug, found by review rather than left as a footnote: `syncRegistry` was
silently clobbering a site's resolved `truthSource` on every re-run.** `mergeSite` has
no database access, so it always produced `truthSource: null` for `upsertSite`; running
`registry sync` after a `crawl` had already resolved a site's truth source (step 5/6)
would reset it to null, undoing that work with no error and no log line — exactly the
silent-failure shape engineering guide §1 rules out. Fixed here: `syncRegistry` now
reads the existing row via `findSiteBySlug` before upserting and preserves its
`truthSource` when one is already recorded, rather than deferring the fix to step 10 on
the reasoning that "something else will read it eventually." Pinned by two new unit
tests in `sync.test.ts` against a fully faked database, clone, and probe — one asserting
a re-sync leaves an existing `'sitemap'` alone, one asserting a genuinely new site still
gets `null` rather than a fabricated value.

**A second review pass fixed two smaller things rather than filing them as findings.**
`registryDriftReport` queried `registry_health` once per site (an N+1 that only mattered
at estate scale); it now reads the newest probe per site in one query via
`listLatestRegistryHealth`'s `SELECT DISTINCT ON (site_id) … ORDER BY site_id,
checked_at DESC`, pinned by a new `report.int.test.ts` that plants an older "live" row
and a newer "dead" one for the same site and asserts the newer one wins. And
`packages/registry`'s `package.json` had declared a dependency on `@link-graph/core`
that nothing in the package imports — removed.

**Left undone:** `resolveDns` has no explicit timeout and visibly stalled on at least
one host during the real run before failing over — never hung indefinitely, but the wall
time is at the mercy of the OS resolver's retry schedule rather than a declared ceiling,
unlike `fetchUrl`'s 10s `AbortSignal`. `registry sync` probes all 163 sites sequentially
(one host at a time, 4m22s); safe under PRD §5.1's per-host limit but un-parallelized,
which is reasonable step 10 scheduler work rather than this step's. No per-site filter —
every run is whole-estate, which is fine at 163 sites and worth revisiting if the
estate's growth makes a full sync too slow to run on demand.

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

| Open item (PRD §15)                                      | Decided at | By what                                          |
| -------------------------------------------------------- | ---------- | ------------------------------------------------ |
| Boilerplate threshold N                                  | step 4     | fixture + two real crawls at 40–80%              |
| ~~Orphan false-positive rate acceptable?~~ **yes, 1.7%** | step 7     | settled 2026-09-02 — see step 7's gate           |
| Are the ~23 sitemap-less real-looking hosts in scope?    | step 5     | what `truth_source = 'none'` actually costs them |
| Safe sustained crawl rate                                | step 6     | crawl telemetry, not more probing                |
| 12-crawl retention                                       | step 13    | measured row counts by then                      |

## Ordering rules

1. **Pure before impure.** Steps 1–2 have no dependencies and decide every number.
2. **Analysis before acquisition.** Step 4 precedes step 6 so the maths is verified
   against a known answer.
3. **Infrastructure arrives when something needs it.** Postgres at step 3, Redis at
   step 10, Astro at step 12 — never earlier.
4. **No step depends on a later step's output.** If one appears to, the split is wrong.
