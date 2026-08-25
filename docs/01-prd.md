# link-graph — Product Requirements

Status: draft · 2026-08-18
Companion to [00-goal.md](00-goal.md) (pitch, gap, success criteria) and
[census.json](census.json) (measured per-site inventory).

---

## 1. Scope of the estate

All figures below are measured, not estimated. See §14 for method.

|                              | Count | Notes                                    |
| ---------------------------- | ----- | ---------------------------------------- |
| Registered prod hostnames    | 165   | from `deployment-configurations`         |
| ...with a readable sitemap   | 95    | **18,531 URLs total**                    |
| ...no sitemap, WP REST works | 10    | coverable                                |
| ...neither sitemap nor REST  | 47    | mostly not content sites                 |
| ...unreachable               | 12    | includes 2 with live pw-template configs |
| ...infra helper              | 1     | `kafka-to-wp-helper.staging02`           |

Median site: **27 URLs**. The ten largest sites hold **73%** of all URLs.
Largest: whyaim.com 3,089 · agent.familyfirstlife.com 2,000* · smsteam.net 1,881 ·
fidelisagents.com 1,391 · gpis4u.org 1,258 · westernassetprotection.com 1,025 ·
tidewatermg.com 989.

\* exactly 2,000 indicates a truncated sitemap; true count unknown and higher.

**Measured 2026-08-20, and the estate is roughly four times the size recorded above.**
Step 5 resolved `agent.familyfirstlife.com` properly and the 2,000 is **not a truncated
sitemap — it is a truncated census**. `/sitemap.xml` 301s to `/wp-sitemap.xml`, which is
a WP-core sitemap **index listing 30 children**; child 1 holds exactly 2,000 URLs (WP
core's per-file cap) and child 30 holds the remaining 1,363. Children 2–29 were not
fetched, so 29 × 2,000 + 1,363 = **59,363 URLs** is inference from the cap — but it is
inference the other source confirms exactly (re-verified independently 2026-08-20: 30 children, child 30 holds 1,363 `<loc>`, and 29 × 2,000 + 1,363 matches `X-WP-Total` to the unit): WP REST reports `X-WP-Total: 59363` for the
same post type. The census recorded one child (`children: 1`).

Consequences, none of them decided here:

- The 18,531 total becomes ≈ **75,894** with this one host corrected, and that host alone
  is then **78%** of the estate. "The ten largest sites hold 73%" and "median 27" need
  recomputing, and other hosts may be truncated the same way — `children` in
  `census.json` is 1 for several sitemapped hosts.
- §7's retention ballpark (1.5M link rows per estate crawl) is low by roughly the same
  factor: 59,363 pages at the ~50 links/page measured in step 3 is ~3M rows from one
  site.
- §5.1's "8–16 concurrent sites keeps a full estate sweep near an hour" cannot hold:
  59,363 pages at 1 req/s is **16.5 hours** for that host, and the limit is per host, so
  concurrency does not help it. This host needs its own answer (rate override, or
  crawling agent pages on a different cadence).
- **A re-census is the user's call**, not step 5's: it is 165 hosts of requests.

Two further census facts, measured the same day: `integrity.com` — the site every
document here argues from — **is not in `census.json` at all**, because
`apps/integrity.com/envs/prod/values.yaml` sets `ingress.enabled: false` and declares no
hostname, so the derivation in §3 cannot see it. It serves fine. That is the inverse of
§3.1's drift (deployed but unmonitored): **served but not registered**, and it is what
§3's curation overlay is for. And `tidewatermg.com`'s sitemap index has **34** children,
where the census records 33.

`census.json` also cannot reproduce the 95/10/47/12 split in the table above: its rows
carry only `urls`, `children` and `via`, so the 70 hosts with no sitemap are one
undifferentiated group. §14 says the sitemap-less hosts were then probed for
`/wp-json/wp/v2/types`; that probe's output is not in the file.

**Coverage is per-capability, not per-site.** Sites without a truth source can be
checked for broken links and structure but can never have orphans detected, because
orphan detection is a set difference against a known inventory. The PRD must never
claim estate-wide orphan coverage.

---

## 2. Definitions

The credibility of this tool rests entirely on these being right. An orphan report
that is 30% noise gets ignored within two weeks.

| Term                  | Definition                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **True orphan**       | Present in the truth source, published, indexable — and zero inbound internal links found anywhere in the crawl.                                                                                                               |
| **Sitemap-invisible** | Present in WP REST but absent from the sitemap. Distinct class: often intentional, sometimes an SEO plugin misconfiguration.                                                                                                   |
| **Excluded**          | Not an orphan by intent: `noindex`, canonical pointing elsewhere, a redirect target, or matched by the site's `ignorePaths`. Counted and shown separately, never in the orphan list.                                           |
| **Undetectable**      | The orphan question cannot be answered here: the site has no truth source, or the crawl was a sample (§15) and absence of an inbound edge proves nothing. Reported as a coverage gap with its reason, never as zero orphans.   |
| **Boilerplate edge**  | A link whose (target, anchor) pair appears on more than N% of crawled pages. Statistical, not structural — this also catches footer widgets, breadcrumbs and related-post modules that a nav-menu-based definition would miss. |
| **Contextual edge**   | Any edge that is not boilerplate.                                                                                                                                                                                              |
| **Blast radius**      | For a broken link: the number of distinct pages linking to it.                                                                                                                                                                 |

**Decision 2026-08-20: the soft-orphan class is dropped.** A page with inbound links is
`linked`, however those links are styled or wherever they sit. Two independent
measurements killed the rule, neither of which was a coding error:

1. **It produced a false positive on real data.** `/contact-us/` on 403bplan.net has two
   genuine in-content links, both in `main`, from `/financial-advisor/` and
   `/plan-participant/`. Their anchor text "Contact Us" matches the header nav entry, so
   the `(target, anchor)` pair sat on 13/13 pages and both were marked boilerplate — the
   page classified `soft_orphan` with zero contextual edges. One of three soft orphans on
   that site was wrong.
2. **The verdict depended on which requests the crawler chose to make.** Boilerplate
   frequency divides by pages _fetched_, so every extra page row lowers every pair's
   ratio. Measured: crawling 403bplan.net's 17 internal PDF links alongside its 13 real
   pages moved the denominator from 13 to 30, put the site-wide nav pairs at 43% — under
   the 60% threshold — and turned **all three** of its soft orphans into `linked`. Zero
   soft orphans for a site that has three, from a decision that looks like it only
   concerns which URLs to enqueue.

A class that flips on the crawler's URL-admission policy cannot carry a report anyone
acts on. **True orphans are unaffected** — they have zero inbound edges, so no frequency
threshold enters the verdict.

`is_boilerplate` is still computed, because PRD §9's section matrix and ego network read
edge kinds. **But threshold N is no longer correctness-critical**: with soft orphans gone,
N cannot change any page's class. It is now a display parameter, which retires the §15
open item's urgency. If §9's views turn out not to need it, the whole boilerplate pass can
go — a separate, smaller decision.

Two further §2 gaps, both measured, both **still open**:

- **A page reachable only through a redirect classifies `orphan` and `unreachable`.** The
  destination is in the truth source, returns 200, and no `<a href>` points at it, so it
  is a true orphan by §2's letter with NULL depth. Redirects live on `pages.redirect_to`
  and never as `links` rows — deliberately, since synthetic redirect edges would enter the
  `(target, anchor)` frequency count. The reading is arguably right ("nothing links here;
  the only way in is a redirect") but it is not what §2 says, and the two should probably
  be told apart.
- **A `noindex` page can hide a real orphan.** Adding the `noindex` search page removes
  `/plan-participant/online-access/` from the orphan set, because its only site-wide link
  comes from that excluded, unreachable page. §2's "anywhere in the crawl" makes this
  correct by the letter and wrong in effect.

Resolved and no longer open: every homepage was a soft orphan by the old letter (12
inbound header-logo links, empty anchor, all boilerplate). With the class gone the
crawl-root exception is no longer load-bearing, though a crawl root is still never an
orphan.

**A sample cannot answer the orphan question per page either (step 5.5).** §15's decision
is written about the crawl-level count, but `analyse` also writes `pages.class` and the
phase-1 tables read it. On a sampled crawl a truth-source page with zero inbound edges is
overwhelmingly likely to be linked from a page the sample never fetched, so calling it an
orphan puts false positives in front of a reader while the crawl total honestly reads
"unknown". One inbound edge still proves `linked` — positive evidence survives sampling;
proving _absence_ does not. A sampled page with no inbound edge is therefore
`undetectable`, and the reason it is unknown lives once, on the crawl.

Excluded-class detection is **phase 1, not later**. Measured evidence: ~10% of
tidewatermg.com's sitemap is non-content (86 `bricks_template`, 164 taxonomy
archives, 4 author archives). Unclassified, that is ~90 phantom orphans on one site.

---

## 3. Site registry

`deployment-configurations` (github.com/img-source) is the canonical upstream and is
**read-only** — link-graph never opens a PR against it.

```
deployment-configurations           ← platform/GitOps owned, READ ONLY
  apps/<app>/envs/{prod,stage}/values.yaml
    ingress.entries[].hosts[].hostname     → host + www aliases
    image.tag                              → deployed version
            │  shallow clone at schedule time; git SHA stamped on each crawl
            ▼
  derived registry  +  committed curation overlay
            ▼
      link-graph sites table
```

Derived per site: `siteId`, canonical host, host aliases, stage host, deployed tag.
Curation overlay supplies: `enabled`, `ignorePaths`, crawler mode, rate override.

**Why a curation layer is required** — the raw repo contains 33 apps with prod values
but no hostname, variant directories (`-v2`, `-2025`, `-traefik-canary`) and non-site
utilities (`all-in-one-wpm-backup`). It also contains entries that are not served by
the platform at all.

**Host aliases are the highest-value thing the registry gives us.** 145 of 312 prod
hostnames are `www.` aliases and 143 apps declare more than one host. Without this
alias table every `www.` link becomes a phantom external node and every apex page
looks orphaned. This is declarative config, not heuristics.

### 3.1 Liveness probe

Registry entries do not imply a live site. Each entry is probed and classified:

`DNS resolves → serves HTTP → carries platform signature (Apache/2.4.68 + CloudFront)
→ /version.txt present`

Measured drift as of 2026-08-18: 7 apps are registered but not platform-served
(2 no DNS, 1 not serving, 4 on third-party hosts — WP Engine, Flywheel, nginx).
These are **work in progress** and enter the registry as `enabled: false`; the
liveness probe flips them on when they migrate.

Conversely, `agents.integrity.com` (no DNS) and `integritymedicarehelpline.com`
(connection refused) are dead but hold live pw-template configs — surfaced as a
registry-health finding.

---

## 4. Truth sources

Resolution order per site, first success wins:

1. **WP REST API** — `/wp-json/wp/v2/types` to enumerate every public post type,
   then paginate each via `X-WP-TotalPages`.
2. **Sitemap** — `sitemap_index.xml`, then `sitemap.xml`, then `wp-sitemap.xml`.
   Index sitemaps nest; children must be followed.
3. **None** — orphan detection disabled for that site; other checks still run.

**Enumerating all post types is mandatory, not an optimisation.** integrity.com's
`pages` post type holds 96 of 1,953 sitemap URLs — 5%. A hardcoded `pages` scrape
sees a twentieth of the site. tidewatermg.com carries 15 content post types.

REST and sitemap disagree in both directions and the disagreement is itself a
finding: integrity.com exposes `promotion` (5) and `webinar` (10) via REST that are
absent from its sitemap.

**Measured 2026-08-20 (step 5), and the two numbers above come from different sources.**
`page-sitemap.xml` lists 96 URLs; WP REST reports `X-WP-Total: 124` for the same `page`
post type, and the 96 are a strict subset of the 124. So **28 published pages are in the
CMS and absent from the sitemap** — `sitemap-invisible` in §2, with a population. Spot-checked live on 2026-08-20 and not recorded as fixtures (they are page HTML, not truth-source responses): `/news/` returns 200, is self-canonical and carries no robots `noindex` or `X-Robots-Tag`, so this is §2's "SEO plugin misconfiguration" rather than intent. `promotion` and `webinar` have
no sitemap child at all (14 children, neither among them), and their permalinks redirect
(`/promotion/august-1-31/` → 301 → `/leadcenter/leadcenter-promotions-updated-weekly/`),
which §2 already classifies Excluded once crawled.

tidewatermg.com's "15 content post types" is the count of **post-type children in the
sitemap index**. REST declares 32 types there, of which 23 are not WordPress's own, and
**8 of those 23 have no sitemap child**: `landing-pages`, `legal`,
`leadcenter-promotion`, `fcrm-dummy`, and the four `gblocks_*` builder types this section
wants classified Excluded. `bricks_template` runs the other way — it has its own sitemap
child and no REST type at all — as do the 18 taxonomy and author children.

**Two rules that cannot be implemented, and one that can.** `/wp/v2/types` does **not**
carry `viewable` unauthenticated (it is an `edit`-context field), so "enumerate the
viewable types" is impossible; and `/wp/v2/blocks` answers `200 []` while `menu-items`
and `templates` answer 401, so "the internal types are the ones that refuse" is
impossible too. What remains is a list of WordPress's own nine non-content types, the
same nine on every site measured (11 types on 403bplan.net, 32 on tidewatermg.com).
`attachment` is one of them: `X-WP-Total` puts it at **4,681 items on integrity.com**,
more than twice that site's sitemap, and the one item sampled is `status: inherit` (an
attachment inherits its parent's status) with an attachment-page permalink. No sitemap in
the estate lists any of them.

**Every reachable WordPress host probed exposes WP REST — 7 of 7**: 403bplan.net,
integrity.com, tidewatermg.com, agent.familyfirstlife.com, agentcore.com,
myagentresourcecenter.com and ifcnationalmarketing.com (the first four are recorded as
fixtures in `packages/truth`; the last three were single live probes). So resolution step 2 (sitemap) may have no live cohort member as a
_primary_ source; its value on this estate is the cross-check, not the fallback.

**Classification runs on the truth source before anything else.** Drop page-builder
artifacts (`bricks_template`, `gblocks_*`), taxonomy archives, author archives and
`ignorePaths` matches into the Excluded class. Rules are per-site: taxonomy archives
are 17% of tidewatermg.com's sitemap but 1% of integrity.com's.

---

## 5. Crawler

**Plain HTTP fetch + HTML parse by default; Playwright opt-in per site via config.**
These are server-rendered WordPress sites, so links are in the HTML. Playwright across
the estate is infeasible; HTTP fetching makes it minutes.

### 5.0 Stack, and why not a framework

| Concern          | Choice                                                |
| ---------------- | ----------------------------------------------------- |
| HTTP             | `undici` — pooling, keep-alive, redirects             |
| HTML parse       | `cheerio` — landmark ancestor walk gives container    |
| Rate limiting    | `bottleneck` — native per-key limiters, keyed by host |
| Frontier + state | Postgres table — resume is a `SELECT`                 |
| robots.txt       | `robots-parser`                                       |
| Sitemap          | `sitemapper` — proven in pw-template, copy it         |
| JS rendering     | `playwright` directly, opt-in sites only              |

Roughly 300-400 lines behind a `crawl(site, urls) -> {pages, links}` interface, so the
decision is reversible in one module.

**Why no crawler framework.** Two requirements decide it. First, **we must parse the
HTML ourselves regardless** — anchor text and DOM container are SEO concerns that no
general-purpose crawler emits (see §6.1). Once parsing is ours, the framework's
remaining job is "fetch this list politely and survive an hour-long ban", which is a
Postgres frontier plus a rate limiter. Second, **our crawl is not frontier-shaped**:
the truth source hands us most URLs up front, so this is a work queue over a known
list rather than open-ended discovery, and `RequestQueue`-style machinery earns little.

Crawlee JS specifically fails both hard requirements: it has **no SQL storage client**
(`MemoryStorage` offloaded to `CRAWLEE_STORAGE_DIR`; Postgres is roadmapped for v4,
and exists only in Crawlee Python), and its rate limiting is **per-crawler, not
per-host** — so a per-host limit means 165 instances of an autoscaling engine we would
configure not to scale. Its real strengths (autoscaling, proxy rotation, session pools,
fingerprinting) address crawling the hostile open web at scale; we crawl our own
uniform estate at 1 req/s.

Scrapy is the strongest alternative and solves both natively
(`CONCURRENT_REQUESTS_PER_DOMAIN`, `DOWNLOAD_DELAY`, `JOBDIR` resume) at the cost of a
second language; revisit if the thin crawler proves painful.

**Rendered HTML is the only link source.** `content.rendered` is empty on every page
sampled from both integrity.com and tidewatermg.com — content lives in page-builder
metadata (Bricks, GenerateBlocks). Parsing `post_content` would require a parser per
builder per version. `<a href>` is universal.

### 5.1 Rate limiting

Measured on whyaim.com, 2026-08-18: Wordfence returns **503 at ~8 req/s sustained,
first block at request ~155**, with `retry-after: 3600` — a **one hour** IP ban.
Short bursts pass regardless of rate (20 req at 40/s was fine), so it is a
rate-over-window limit, not a burst limit. Blocks are per-IP and per-host.

**Measured 2026-08-20 (step 6): `X-Robots-Tag` exists on this estate.**
`403bplan.net/wp-json/` answers 200 with `x-robots-tag: noindex`. It is a response header,
so `extractPage` cannot see it and step 2 deferred it to the crawler; `pages.indexable`
must therefore be `meta robots` and this header together. No _page_ carrying it has been found yet — the
`noindex` pages measured so far declare it in the body (Yoast) — so the header is handled
because it is cheap and its absence would silently manufacture orphans, not because a
page needing it has been seen.

**Also measured: an apex/`www` mismatch in the registry doubles a crawl.** `normalizeUrl`
collapses aliases, so a 301 from the registry's canonical host to the host the server
actually serves names the _same_ node; the crawler follows it inside one page fetch rather
than recording it, because recording it would store every page of such a site as a 301 to
itself and never read a body. The cost is one extra request per page, paced by the same
per-host limiter — so on a site whose canonical host is wrong, a 16.5-hour crawl becomes
33 hours. `CrawlResult.aliasHops` counts them; nothing stores the count yet.

Requirements:

- Default **~1 req/s per host**; per-site override in the curation overlay.
- Back off on the **first** 503 and honour `retry-after`.
- **Persist crawl state and resume.** A block 1,800 pages into a 3,000-page crawl
  pauses that host and continues later — it does not restart and does not fail the run.
- **Parallelise across hosts freely** — the limit is per host. 8–16 concurrent sites
  keeps a full estate sweep near an hour.
- Record observed thresholds per site over time; tune from data rather than config
  archaeology.

CloudFront fronts every site, so cached pages cost the origin little — but a crawl
of distinct URLs is nearly all cache misses and does reach Wordfence.

---

## 6. Link classification

Every extracted edge is classified on two axes:

- **Internal / external** — resolved against the site's full host-alias set, so
  `www.` and apex are the same site.
- **Boilerplate / contextual** — an edge whose (target, anchor) pair appears on
  more than N% of crawled pages is boilerplate. N is tunable; start at 60%.

### 6.1 Link verification

Verification splits three ways, and only one third of it is ours to build:

| Job                                                                    | Owner                                 |
| ---------------------------------------------------------------------- | ------------------------------------- |
| Traverse our sites, extract links **with anchor text + DOM container** | **Ours** — no existing tool does this |
| Verify **external** URLs are alive, politely, cached                   | **lychee** — purpose-built            |
| Verify **internal** URLs                                               | Free — the crawl already fetched them |

**Internal link status needs no separate check.** The crawler fetches every internal
page and records its status code, so a broken internal link is a join, not a request.
The exception is non-HTML internal targets (PDFs, media) the crawler does not fetch;
those go through the same path as external.

**Measured 2026-08-20 (step 6), and that exception earns its keep twice over.** Crawling
403bplan.net's 17 internal `/wp-content/uploads/*.pdf` links took the run from 13 requests
to 30 — **+131%** on a site of 13 pages, against a per-host rate limit where requests are
the scarce resource — and diluted the boilerplate denominator until three real soft
orphans read as `linked` (see §2). The crawler therefore skips a discovered URL whose
extension names a media or document type, records it on the frontier as `skipped` with
the extension as the reason, and leaves the status to this section's checker. Two limits
of the rule, both deliberate: it applies to _discovered_ URLs only, so it can never drop
an inventory URL and can never hide an orphan; and an extension nobody listed is still
fetched, because the content type is then the only thing that can tell (`.pdf` is the only
media extension any of the 20 checked-in captures uses in an `<a href>`, so the list is
one measurement plus the file formats this section already names).

**External links are checked once, centrally, and shared across all 165 sites** via a
URL-keyed table with a TTL. This is the single strongest argument for centralisation:
the same third-party URL appears across many sites and must not be checked many times.
Third-party 429/403 is recorded as _unverified_, never as _broken_.

The checker is **[lychee](https://github.com/lycheeverse/lychee)** — a Rust static
binary that already provides everything this component required: per-host throttling
(`--host-concurrency`, `--host-request-interval`), rate-limit awareness with
retry/backoff, scheme and pattern exclusions, and JSON output. It ships into the worker
image as a binary with no language contamination, invoked as a subprocess.

`external_urls` remains the source of truth, **not** lychee's `.lycheecache`. Our table
is queryable, shared across sites, and owns the TTL policy; select the URLs due for a
recheck, pass only those to lychee, ingest the JSON back. Its own cache is redundant
and stays disabled.

Evaluated and rejected as the _crawler_: Crawlee JS (no SQL storage client until v4;
rate limiting is per-crawler not per-host), Katana, muffet, linkinator, Scrapy. Every
one of them fetches and verifies well, and none emit anchor text or DOM container --
that is an SEO concern rather than a link-checking one, which is precisely why the
extraction layer stays ours. See §5.

---

## 7. Data model

Postgres. Graph maths stays in SQL — inbound counts and section matrices are
`GROUP BY`, crawl depth is a recursive CTE. At this scale no in-memory graph layer
is needed.

```
sites            id, site_id, canonical_host, aliases[], stage_host,
                 enabled, truth_source, crawler_mode, rate_limit, ignore_paths[]
registry_health  site_id, checked_at, dns_ok, serves, platform_sig, version_txt

crawls           id, site_id, env, started_at, finished_at, status,
                 deployed_tag, registry_sha, pages_seen, was_throttled
pages            id, crawl_id, url_normalized, path, post_type, status_code,
                 depth, in_truth_source, indexable, canonical_to, redirect_to, class
links            id, crawl_id, from_page_id, to_url_normalized, to_page_id,
                 anchor, rel, is_external, is_boilerplate
external_urls    url_normalized, last_checked, status_code, unverified  -- shared, TTL

crawl_metrics    crawl_id, orphans, excluded, broken, external, ...
crawl_diffs      from_crawl_id, to_crawl_id, kind, url, detail
```

**URL normalization is its own package with its own test suite, built first.**
Trailing slashes, `?utm_*`, case, www vs apex, http vs https, fragments and WP's
`?p=123` all create phantom nodes that present as orphans and broken links. The
existing pw-template helper (`baseUrl.replace(/\/+$/,"")` plus `.replace(base,"")`)
is adequate for a 10-item list and nowhere near sufficient for node identity.
Keep its root-relative path convention — it makes cross-environment comparison natural.

**Retention.** Full link-level detail for the last 12 crawls per site (~3 months at
weekly cadence), then roll up to `crawl_metrics` kept indefinitely. Ballpark 1.5M link
rows per full estate crawl; ~18M rows retained. Comfortable for one Postgres instance.

---

## 8. Architecture

Docker Compose on a single VM.

```
  scheduler ──enqueue──> redis ──> worker × N ──> postgres <── api <── web (Astro)
      │                            crawl / analyse / linkcheck queues
      └── shallow-clones deployment-configurations, reads image.tag

  crawl     : undici + cheerio + bottleneck, Postgres frontier   (ours)
  analyse   : SQL — inbound counts, depth, orphan set difference (ours)
  linkcheck : lychee subprocess over due external URLs           (vendored binary)
```

Three queues, one worker image — isolation without a distributed system. Playwright
builds as a separate heavier image from the lean api/web ones; the lychee static
binary is vendored into the worker image.

Operational requirements this adds versus a managed platform:

- **Postgres backup.** It is the system of record and holds history that cannot be
  re-derived.
- **Static egress IP**, so the crawler can be identified in logs and allowlisted later.

**The scheduler owns crawling. Jenkins does nothing.** Release attribution is
preserved without CI integration by reading `image.tag` from the registry at crawl
time — diffs can still say "these orphans appeared between v1.6.8 and v1.7.0".
Note 49 apps currently run different tags in prod and stage.

Cadence: weekly full crawl per site. Prod only in phase 1; staging is publicly
reachable and becomes a phase-2 config flag.

---

## 9. Interface

Two audiences, equal priority: **one data layer, two view sets.**

|         | Engineers                           | Content / SEO            |
| ------- | ----------------------------------- | ------------------------ |
| Entry   | API, CLI, raw tables                | Per-site guided view     |
| Framing | "orphans", "inbound edges", "depth" | "pages nothing links to" |
| Task    | query, export, diff                 | work a fix list          |

A plain-language layer is a **requirement, not polish** — the same number needs two
names.

**Node-link graphs are a drill-down, not the front page.** Force-directed layouts
degrade into hairballs past a few hundred nodes, and websites are the worst case
because global nav makes nearly every page link to nearly every other. Primary views:

1. **Sorted tables** — orphans, broken links by blast radius. The
   deliverable.
2. **Treemap / icicle** of URL hierarchy, coloured by inbound count or orphan status.
   "Site shape at a glance", scales to thousands.
3. **Section→section matrix** — aggregate link counts at a readable altitude.
4. **Distribution charts** — depth, status codes, link counts. _This is the
   TanStack Charts slot._
5. **Ego network** — one page, 1–2 hops. Node-link earns its place here, ~50 nodes,
   plain SVG.

---

## 10. Notifications

With no CI gate, **notifications are the only mechanism that causes action.** Nothing
fails, so if nobody opens the dashboard nothing happens. This is core, not phase 4.

Follow existing conventions (`utils/notify-asana.sh`): a scheduled digest, plus alerts
when new orphans or broken links appear or when registry health changes.

---

## 11. Non-goals

Not an SEO audit suite. No title/meta/heading analysis, readability, spell checking,
schema or hreflang validation, or accessibility scanning — that lives in pw-template.

**If a feature is not about links, reachability, or change over time, it is out of
scope.** Chasing Screaming Frog's feature list produces a worse Screaming Frog.

Also out: third-party backlink data (licensed), GSC/GA integration (possible later,
not now), and any modification of pw-template or deployment-configurations.

---

## 12. Phases

1. **Truth source + normalization.** CLI only, no UI, no queue. Crawl one site to
   Postgres and print the orphan table. Validates URL normalization and the
   REST/sitemap reconciliation — the two things that decide whether anyone trusts this.
2. **Classification + broken links + external link cache** (lychee integration).
3. **Registry + liveness probe + multi-site scheduling.**
4. **API + Astro: tables and treemap.** Both audiences.
5. **Diffs, history, notifications.**
6. **Ego-network drill-down; staging crawling.**

---

## 13. Risks

| Risk                                        | Mitigation                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| Orphan false positives destroy trust        | Excluded-class detection in phase 1; measure FP rate before wider rollout |
| URL normalization bugs create phantom nodes | Own package, own test suite, built first                                  |
| Wordfence blocks cost an hour per host      | 1 req/s default, first-503 backoff, resumable state                       |
| Scope creep toward an SEO suite             | §11, enforced                                                             |
| Truncated sitemaps under-report             | Cross-check REST totals against sitemap counts; flag disagreement         |
| 47 sites have no truth source               | Report as coverage gap; never report "0 orphans" for them                 |

---

## 14. Method

Estate figures measured 2026-08-18 by fetching every registered prod hostname's
sitemap index and summing child sitemap `<loc>` counts; sitemap-less hosts were then
probed for `/wp-json/wp/v2/types`. Raw output in `census.json`. Rate limits measured
by ramped probing of whyaim.com until Wordfence returned 503.

## 15. Open

- **Settled 2026-08-20 — templated sites are sampled, never fully crawled.**
  `agent.familyfirstlife.com` is 59,363 pages that are one page with a per-agent
  substitution, so exhaustive crawling buys nothing for 16.5 hours of request budget.
  Such a site is crawled to a page ceiling, and the consequence is
  stated rather than hidden: **orphans cannot be computed from a sample**, because orphan detection is a set difference against the
  whole truth source. A sampled site therefore reports `orphans = NULL` with the reason
  "sampled by policy" — never 0, and never a coverage _failure_ either, since the
  shortfall is deliberate. Broken links and structure are still checked on the sample.
  Step 5's coverage gate must recognise the scope instead of refusing forever. Which other
  hosts are templated is unmeasured; the census cannot tell a template from a content
  site.

  **Amended 2026-08-24 (step 5.5), on the column rather than the decision.** This was
  written as `crawler_mode = 'sample'`. `crawler_mode` is _which fetcher_ — `http` or
  `playwright` (PRD §5) — and sampling is _how much of the site_; a third value there
  would make "sample a Playwright site" unrepresentable. Sampling is therefore its own
  axis, `sites.crawl_scope IN ('full', 'sample')` with `sample_ceiling`, paired by a
  CHECK so that `sample` without a ceiling — a full crawl wearing the label — cannot be
  written down. Nothing else about the decision changes. The NULL orphan count now
  carries `crawl_metrics.orphans_unknown_reason`, because "no truth source" and "sampled
  by policy" are different facts with different remedies and a bare NULL cannot say
  which.

- Are the ~23 sitemap-less, REST-less hosts that look like real sites in scope?
  (The other ~24 are planenroll funnels, rate calculators and APIs — presumed out.)
- Boilerplate threshold N — start at 60%, tune against real data.
- Wordfence per-site thresholds — deliberately deferred; learn from crawl telemetry.
- **Cross-estate link identity.** `normalizeUrl` deliberately applies WordPress path
  rules only to the site being crawled, so integrity.com's link to
  `lionstreet.com/about` normalizes without a trailing slash while lionstreet.com's
  own crawl stores `/about/`. `links.to_url_normalized` therefore will not join to
  another site's `pages.url_normalized`, and cross-estate blast radius would
  under-count. Two options, to be decided at step 3/4: re-normalize against the target
  site at analysis time, or give `normalizeUrl` the registry's known-WordPress host set
  and let it treat any estate host as permalink space. Surfaced 2026-08-19 by the
  step-1 corpus.

  **Second facet, measured 2026-08-20:** the trailing slash is not the only split. One
  page — Integrity's privacy policy — is linked from four estate sites as three
  distinct identities: `integrity.com/privacy-policy` (×3), `.../privacy-policy/` (×1)
  and `www.integrity.com/privacy-policy` (×2), while integrity.com's own crawl stores
  the slashed apex form. So option 2 only works if it also receives the **alias
  table**, not just the host list.

- **Volatile query parameters mint a new node every crawl.**
  `tidewatermg.com/wp-login.php?action=logout&_wpnonce=76e5523bda` is a real extracted
  internal link; `_wpnonce` changes per response. It is not in `url.ts`'s
  `WP_NOISE_PARAMS` and `/wp-login.php` is not in `WP_INFRA_PATH`. Three candidate
  homes — a noise param, a registry `ignore_paths` entry, or step 4's Excluded rules —
  and the choice decides whether `crawl_diffs` (PRD §13) reports churn forever.
  Deliberately not decided at step 2.
