# Improvement plan (from docs/notes.md)

Phased plan grouping the items in `docs/notes.md` by theme and dependency. Bugs and
ops reliability come first since they gate correctness of everything downstream;
the design-system pass is explicitly deferred to last (item 18's own note).

Each phase gets its own step-by-step plan (with a verification step per change)
worked out just before that phase starts, not all up front.

## Phase 1 — Crawl/registry correctness bugs
Notes: 1, 2, 19

Redirect handling in liveness probing, crash on a 301 homepage, external-linkcheck
egress-failure false-negative. These corrupt data if left unfixed, so they gate
everything downstream.

Decisions from clarifying questions:

- **Note 1 (cross-host redirect, e.g. askintegrity.com → integrity.com):** new,
  distinct site status `alias` (not reusing `disabled`), storing the redirect target
  host. An aliased site is still re-probed on every `registry sync` and can flip back
  to `enabled` if the redirect disappears.
- **Note 2 (zip.planenroll.com/ → 301 → /agent, same-host):** before deciding the
  general handling rule, run an investigative probe: does every page on the host
  redirect under the same prefix (e.g. `/thanks` → `/agent/thanks`), or is it just the
  homepage? That shapes whether "follow same-host redirect for the root" is safe in
  general or needs a smarter per-path rule.
- **Note 19 (external-linkcheck egress failure):** use BullMQ's own job-level
  `attempts` + `backoff` options on the linkcheck job, rather than a custom retry loop
  inside `checkExternalUrls`. Minimal new code, reuses existing queue infra.

**Done** (2026-09-28): Notes 1 and 19 implemented and verified against the real
estate — `registry sync` now finds 10 redirect aliases including
`askintegrity.com -> integrity.com`; linkcheck job retries via BullMQ `attempts`/
`backoff`. Note 2's investigative probe confirmed the redirect is same-host and
root-only (not a path-prefix pattern), so it correctly stays outside the alias
mechanism — but the actual crash in `analyse.ts:158` ("crawl's homepage returned
301, so reachability has no usable root") is still unfixed. **Folded into Phase 6**
below, since it's a failed-crawl-handling problem, not a registry/liveness one.

## Phase 2 — Ops reliability & visibility
Notes: 10, 14, 4, 20, 21, 9

Fix flaky `npm ci`, get the astro web package booting with docker compose, add Bull
Board to the stack, figure out how to see a currently-running crawl, investigate Bull
Board slowness, backfill the operations doc gaps (9b/9c overlap with 4/20).

Decisions from clarifying questions:

- **Note 10 (flaky `npm ci`):** no known cause yet — reproduce the worker image build
  failure from scratch, read the actual npm error, then fix.
- **Note 14 (astro web in compose):** full container service — add a `web` service to
  `docker-compose.yml` with its own Dockerfile, same pattern as `worker`.
- **Note 4 (Bull Board):** full compose service — add a `bull-board` service so it
  starts/stops with the rest of the stack automatically, not an ad hoc command.
- **Note 20 (see the running crawler):** this is really about worker *process*
  liveness, not which site is active (Bull Board's Active tab already shows that) — the
  existing health checks (`docker compose ps`, `ps aux | grep scheduler`) already cover
  it; this phase just needs to document that clearly in the ops doc rather than build
  anything new.
- **Note 21 (Bull Board slow):** diagnose and fix now. Leading hypothesis: the 12 stale
  duplicate `scheduler/src/bin.ts` host processes found and killed earlier in this
  project (each registering its own job schedulers) may have been the cause — first
  re-check Bull Board responsiveness now that those are gone, then dig into Redis
  memory/key counts if it's still slow.

**Done** (2026-09-28), verified end to end with a full fresh-volume `docker compose up
-d --wait`:

- **Note 10:** root cause was never npm — this network's Zscaler TLS interception had
  no trusted CA inside `node:22-slim`, which npm 10.9.9 mangled into a useless "Exit
  handler never called!" message. Fixed by baking `certs/zscaler-root-ca.pem` into
  `Dockerfile.worker`'s build and runtime stages. Getting the build to actually
  succeed for the first time then surfaced two more latent bugs, fixed in the same
  pass: `scripts/` was never `COPY`'d into the image, and the vendored `lychee`
  release targeted `gnu` (needs glibc 2.38+) against a base image with glibc 2.36 —
  switched to `lychee`'s `musl` static build, which has no libc dependency. Verified
  `npm ci`, `fetch-lychee.sh`, and `lychee --version` all work in the built image, and
  the worker boots with linkcheck enabled (no "linkcheck disabled" fallback message).
- **Note 14:** `Dockerfile.web` + a `web` compose service (build-then-run, same
  pattern as the worker), serving the real sites list and a site details page against
  live Postgres at http://localhost:4321.
- **Note 4:** a `bull-board` compose service, plain `node:22-slim` + `npx` (no
  dedicated Dockerfile — reuses the same CA-cert fix, mounted rather than baked in,
  since there's nothing here to build). Bound to `127.0.0.1` only: the CLI itself
  warns that with no auth configured, anyone reaching it can modify or delete any
  queue's jobs, not just view them.
- **Note 20:** no code needed — this was about worker *process* liveness, which the
  existing `docker compose ps` / `ps aux` health checks already answer; documented
  that clearly in the ops doc instead of building something new.
- **Note 21:** confirmed, not just hypothesized — after killing the 12 duplicate
  processes, Redis measured trivially small (2MB, 322 keys) and Bull Board responded
  in single-digit milliseconds. The duplicate processes were the actual cause.
- **Note 9 (a/b/c):** ops doc now explains why the worker process has to keep
  running (it's the thing pulling jobs off the queues, not just a one-time scheduler
  registration) and that it does not re-run `scheduleWeeklyCrawls` on any timer;
  documents Bull Board; and settles 9c by pointing at the VS Code Database Client
  extension already in use rather than adding a Postgres-side Bull Board equivalent.

## Phase 3 — Scheduling tweak
Notes: 5

Change `WEEKLY_CRON` to run Sunday instead of Monday. Trivial, standalone.

**Done** (2026-09-28): the `WEEKLY_CRON` value itself was already changed to Sunday
(`0 3 * * 0`) in an earlier commit ("update cron"), before this plan existed — this
pass just caught up the stale references that hadn't been updated with it: the test
suite (`schedule.test.ts`, fixed in Phase 1's cleanup pass since it was blocking a
clean test run there) and a doc comment directly above `WEEKLY_CRON` in
`schedule.ts` that still said "Monday 03:00" over a value that was already Sunday.

## Phase 4 — Web data completeness
Notes: 6, 11, 3

Sites list needs richer per-site info (last crawl, crawl count, next crawl time),
site details page needs external-links/all-pages lists, external-link 404 checking
needs a view. Surfacing data that exists or nearly does.

Decisions from clarifying questions:

- **Note 3 (external 404 checking view):** not confirmed whether it actually runs end
  to end — investigate first (note 19's egress-failure bug suggests it does run, but
  may be silently failing), then build the missing view once confirmed.
- **Note 6 (next crawl time):** read BullMQ's actual scheduled next-run per site
  (job scheduler's own repeat data), not a value computed from `WEEKLY_CRON` in
  isolation — more accurate, reflects any per-site scheduling drift.
- **Note 11 (external links / all pages lists):** add pagination/virtualization from
  the start, not a plain full list — some sites in the estate are large enough for it
  to matter.

**Done** (2026-09-28), verified against live data:

- **Note 3:** confirmed by investigation, not assumed — external linkcheck genuinely
  runs and writes real results (6,129 rows in `external_urls`, 327 real 404s found on
  integrity.com alone, distinct from the 583 unverified/blocked). The gap was purely
  "no view", now built (below).
- **Note 6:** sites list now shows last-crawl date, complete-crawl count
  (`listCrawlSummaries`, one aggregate query, not 164 round trips), and next-crawl time
  read live from BullMQ (`listNextCrawlTimes`, `getJobSchedulers`) rather than computed
  from `WEEKLY_CRON` — a disabled site correctly shows "disabled" instead of a stale or
  fabricated date.
- **Note 11:** site details page now has a paginated external-links list (worst-first:
  not-yet-checked, then broken, then 2xx) and a paginated all-pages list, 50 rows/page,
  plain SSR query-param pagination (`?extPage=`/`?pagesPage=`) — verified against
  integrity.com's real 643 external links (13 pages) and 2,463 pages.
- Centralized a `redisUrl()` fallback in `packages/scheduler` (mirroring `packages/db`'s
  `databaseUrl()`), used by both `bin.ts` and the new web-side Redis reads, so the web
  service needed `REDIS_URL` added to its compose environment too.
- Found and documented a real test-isolation gotcha along the way: `docker compose up`
  running the real `worker` service races BullMQ integration tests that spin up their
  own in-process queue consumers on the same Redis — noted in `docker-compose.yml`.

## Phase 5 — Web interactivity
Notes: 13, 17

Search bar to filter the sites list, at-a-glance per-site stats (broken links count,
unreviewed orphan count) in a sortable table. Both likely one tanstack-table effort.

Decisions from clarifying questions:

- **Note 13 (search bar):** text search on name/id *plus* stat-facet filters (has
  broken links, has unreviewed orphans, disabled/alias, etc.), not text-only.
- **Note 17 (sortable table):** client-side over all sites — 164 sites is small enough
  to fetch once and let tanstack-table sort/filter/paginate in the browser, no new
  server-side query surface needed.

**Done** (2026-09-30), verified against live data:

- Added `listLatestCrawlMetricsPerSite` (`packages/db/src/repo/crawl-metrics.ts`) — one
  `DISTINCT ON` query joining `crawls`/`crawl_metrics` for every site's latest complete
  crawl, rather than re-deriving orphan/broken counts from `findings.ts`'s per-row,
  full-link-scan queries 164 times per home-page request.
  `runReportCommand`'s per-site cost (confirmed ~9 queries + a full link/page scan,
  127,845 links on integrity.com alone) makes it unusable for a list page, so the home
  page reads the stored `crawl_metrics` rollup instead.
  No `accepted`/`reviewed` column exists yet (Phase 6 isn't built), so "unreviewed
  orphan count" is just the raw `orphans` count for now — `finding_reviews` never
  changes a measured number (PRD §7.1), so there's no smaller subset to show.
- `packages/web/src/components/SitesTable.tsx`: a React/tanstack-table island
  (`client:load`) — text search (site id/host), status facet (enabled/disabled/alias),
  "has broken links"/"has orphans" checkboxes, and click-to-sort columns, all
  client-side over the ~164 rows fetched once at SSR time.
  `@tanstack/react-table` v9 (initial install) turned out to be an unrelated
  ground-up rewrite with no `useReactTable`/`getCoreRowModel` — pinned to the stable
  v8 line instead.
- Verified against the real estate via the rebuilt `web` container: 164 of 164 sites
  render, the 10 redirect aliases from Phase 1 show `alias` status, and per-site
  broken/orphan counts match `crawl_metrics` (e.g. a never-crawled site shows
  "unknown" orphans rather than a fabricated zero).

## Phase 6 — Review/debugging workflows
Notes: 7, 16, 2 (remainder)

Flesh out the orphan-page review flow (accept an orphan as OK). Develop a workflow
for debugging failed crawls: per-page ignore-links config, retry strategy.

- **Note 2 remainder (zip.planenroll.com/ → 301 → /agent crash):** Phase 1 confirmed
  via investigative probe that the redirect is same-host and root-only (other paths
  404 normally, not a `/thanks` → `/agent/thanks` prefix pattern) — so "follow a
  same-host root redirect and treat the target as the reachability root" is safe as a
  general rule here, not just a special case. Still needs the actual fix in
  `packages/analyse/src/analyse.ts:158` (currently throws when the homepage returns
  301, per docs/notes.md item 2's error) plus a decision on whether this belongs in
  `analyse.ts` itself or upstream in the crawl fetch step that resolves the homepage
  URL.

Decisions from clarifying questions:

- **Note 7 (orphan acceptance persistence):** an acceptance is not permanent-until-
  reverted — if a later crawl finds the page's link structure changed meaningfully
  (e.g. it's no longer an orphan, or context changed), re-surface it for review rather
  than silently keeping the old acceptance.
- **Note 16 (ignore-links config):** scoped to specific link URLs/patterns (e.g. known-
  noisy third-party trackers) that get excluded from checking/counting wherever found
  — not whole pages skipped from the crawl.

**Done** (2026-09-30), verified against live data:

- **Note 2 remainder:** `analyse.ts` no longer throws unconditionally on a non-2xx
  homepage. When the homepage redirects (3xx) and `pages.redirect_to` names a page this
  same crawl fetched as a usable 2xx, that page becomes the reachability root instead —
  the homepage row itself still classifies `excluded` (the existing `redirectTo !== null`
  rule in `classify.ts` already covers that). When the target is missing or not itself
  usable, the refusal still fires, now naming the redirect chain in the message. No
  schema change: the crawler already recorded `redirect_to` and queued the target as its
  own page (`fetch-page.ts`) — confirmed by research before writing the fix, not
  assumed. Verified against the real crawl from the original bug report (crawl 31,
  zip.planenroll.com) and a newer one (crawl 179): both show `/agent/` itself 404ing, so
  this specific site still correctly refuses — the fix only succeeds when the target is
  genuinely usable, which a new `analyse.int.test.ts` case covers with a synthetic
  same-host redirect to an already-200 page (`/plan-participant/`), alongside a second
  new case proving a redirect to an unfetched target still refuses.
- **Note 7:** the backend (reviews, evidence digests, re-surfacing on change via
  `reappearedSubjects`) was already fully built from earlier work — `link-graph note`
  already does everything the note asked for from the CLI. The actual gap was a web UI
  write path, so `packages/web/src/pages/sites/[slug]/review.ts` (a POST endpoint
  calling the same `runNoteCommand` the CLI calls) plus an inline form on each finding
  row in `FindingTable.astro` now let a reviewer mark a finding `intentional` or
  `acknowledged` with a note, right from the report page. Verified end to end against a
  real finding (jbergassociates.com's `/blog/` orphan): submitted via `curl` exactly as
  the browser form would, confirmed the row landed in `finding_reviews`, confirmed the
  page re-rendered it as reviewed, then deleted the test row.
- **Note 16:** a new curation-overlay field, `ignoreLinkPatterns` (parallel to the
  existing `ignorePaths`), stored on `sites.ignore_link_patterns`
  (`014_ignore_link_patterns.sql`). Substring match against the external link's URL,
  applied in the three queries that select a crawl's external links
  (`listExternalUrlsDue`, `listExternalLinksForCrawl`, `countExternalUrls`) via a join
  from `links` through `crawls` to the owning site — not a column on the shared
  `external_urls` table, since the same tracker URL linked from a second site with no
  config of its own is still worth checking there. Verified against real data: set
  `ignore_link_patterns = {facebook.com}` on smsteam.net (1,038 of its 7,352 distinct
  external links), confirmed `countExternalUrls` dropped to exactly 6,314 and
  `listExternalUrlsDue` contained zero `facebook.com` URLs, then reverted the test
  change.

## Phase 7 — UX polish
Notes: 12, 8, 15

Ego-page "Class" column naming or explainer header. Explain the treemap/distributions/
section-matrix views (what insight each gives). External-link icons + aria labels +
new-tab behavior wherever ego-network pages link out.

Decisions from clarifying questions:

- **Note 12 ("Class" column):** meaning not confirmed yet — find what it currently
  represents in the ego page component/data source before proposing a rename or
  explainer.
- **Note 8 (view explanations):** inline on-page (an info icon/tooltip, or a short
  intro paragraph above each chart), not a separate linked docs page — stays visible
  without leaving the view.

## Phase 7b — New items (added 2026-09-30, after phases were planned)
Notes: 22, 23

- **Note 22:** ego network toggle to include external links.
- **Note 23:** overflow bug on site detail pages (e.g. `/sites/simkt.com/`), needs
  reproducing before a fix.

Not yet scoped with clarifying questions — folds into Phase 7 (UX polish) rather than
its own phase, since both are presentation-layer fixes on existing pages. Not started
until Phase 7 begins.

## Phase 8 — Design system pass
Notes: 18

Claude Design with the integrity.com design system, front-end look and feel. Explicitly
deferred by the user to later, once usage limits reset. Not started until asked.

---

## Status

- [x] Phase 1 (note 2's crash fix folded into Phase 6)
- [x] Phase 2
- [x] Phase 3
- [x] Phase 4
- [x] Phase 5
- [x] Phase 6
- [ ] Phase 7
- [ ] Phase 8 (deferred — do not start unprompted)
