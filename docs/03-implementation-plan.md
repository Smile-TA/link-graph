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

## Step 2 — `core`: link extraction — S

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

**Done when** each fixture yields its expected link set and head signals.

---

## Step 3 — `db`: schema, migrations, and a fixture loader — M

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

**Done when** `npm run test:integration` brings up Postgres, migrates, loads a
fixture, and reads it back.

---

## Step 4 — `analyse`: the orphan set difference — M

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

**Done when** a hand-built fixture — transcribed from a real ~27-URL site, not
invented — with one planted true orphan, one soft orphan, and one `noindex` page
produces exactly those three classifications and nothing else.

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
