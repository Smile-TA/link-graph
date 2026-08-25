# link-graph — Engineering Guide

Companion to [01-prd.md](01-prd.md). Short on purpose: a guide nobody reads is a
guide nobody follows.

---

## 1. The one rule that outranks the others

**A failure must never look like a success.**

pw-template learned this the hard way. From `getLinksByType.js`:

> Previously this did `process.exit(error.statusCode)`, but axios errors have no
> `statusCode`, so a failed scrape exited 0 and tests ran against a stale `pages.ts`.

The same failure mode is fatal here, and worse. A crawl that fetches nothing must
never report "0 orphans" — that reads as _good news_. Every empty or partial result
is either a loud error or an explicitly labelled `undetectable`.

Concretely:

- A truth source returning `[]` is a failure, not an answer. (pw-template already
  encodes this: a 200 with an empty array falls through to the next source.)
- A crawl that ends early — Wordfence block, timeout, network — is `status: partial`,
  and partial crawls never produce diffs or metrics as though they were complete.
- Sites with no truth source report `undetectable`, never `0`.
- Never `catch` and continue without either re-throwing or recording the degradation
  in the row you write.

---

## 2. YAGNI

**The scope test, from PRD §11:** if it is not about links, reachability, or change
over time, it is out of scope.

Applied to code:

- **No abstraction until the second caller.** No storage adapter interface while
  Postgres is the only store. No plugin system. No generic "connector" layer.
- **No config option until a real site needs it.** The curation overlay grows from
  observed sites, never from imagined ones.
- **No feature flag for a decision already made.** We chose prod-only in phase 1;
  that is an `if`, not a configuration surface.
- **Delete speculative generality on sight.** Two implementations of the same idea is
  a bug, not flexibility.

### 2.1 What YAGNI does _not_ mean

YAGNI defers **speculative** work. It does not defer **known requirements that are
cheap now and expensive later**. Three things are in scope from day one despite
looking like over-engineering:

| Built early                                     | Why it is not speculative                                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Resumable crawl state                           | Measured: Wordfence bans for one hour. Retrofitting resume into a crawler means rewriting its loop.                                          |
| URL normalization as its own package with tests | Node identity is load-bearing. Every downstream number is wrong if this is wrong.                                                            |
| Excluded-class detection                        | Measured: ~10% of one site's sitemap is non-content. Shipping without it means shipping ~90 false orphans and losing user trust permanently. |

The distinction: _we measured that we need these._ That is not speculation.

---

## 3. TDD

### 3.1 Where TDD is mandatory

Pure, edge-case-dense functions where a wrong answer is silent and consequential:

- **URL normalization** — trailing slashes, `?utm_*`, case, www vs apex, http vs
  https, fragments, WP `?p=123`
- **Link classification** — internal/external against the host-alias set;
  boilerplate/contextual thresholds
- **Truth-source classification** — excluded vs orphan-eligible
- **Orphan set difference** and the crawl **diff** computation

Write the failing test first. These have knowable inputs and exact expected outputs,
which is precisely the shape TDD is good at.

**Fixtures come from the real estate, not from imagination.** `census.json` holds
165 real hosts, and the crawl gives real HTML. A normalization test suite built from
invented URLs proves nothing; one built from `whyaim.com/10025-2/` and
`lionstreet.com` vs `www.lionstreet.com` proves something.

### 3.2 Where TDD is theatre

Astro components, Docker Compose wiring, the lychee subprocess glue, SQL migrations.
Test these where cheap, but do not drive their design from tests. Integration and
smoke coverage is the right tool.

**TDD for the domain core, not the shell.**

### 3.3 Discipline

Red, green, refactor. A test that has never failed has proven nothing — if it passes
the moment you write it, break the implementation deliberately and confirm it fails.

---

## 4. Testable in isolation

### 4.1 Layering

```
core/       pure functions. NO I/O. No fs, no network, no db, no clock, no random.
adapters/   all I/O, behind narrow interfaces. Thin — no business logic.
services/   wiring only. Composes adapters + core. Almost no branching.
```

If a rule is hard to test, it is in the wrong layer. Move it into `core/`.

### 4.2 Inject dependencies at the boundary

pw-template already has the right pattern in `preparePages.ts`, and we adopt it
verbatim:

```ts
/** Injectable scrape sources so tests can mock the fetch (never hits network). */
export interface ScrapeDeps {
  fetchApi: (baseUrl: string) => Promise<string[]>;
  fetchSitemap: (baseUrl: string) => Promise<string[]>;
}
```

Every service exposes its I/O as an injectable interface with a real default.
**Unit tests never touch the network.** Not "rarely" — never.

The crawler's seam is the one named in PRD §5.0:

```ts
crawl(site: Site, urls: string[]): Promise<{ pages: Page[]; links: Link[] }>
```

Behind that interface the implementation is swappable (see PRD §5.0 on Crawlee and
Scrapy as fallbacks). In front of it, everything is pure and testable.

### 4.3 Test tiers

| Tier          | Runs                              | Needs                     | Budget           |
| ------------- | --------------------------------- | ------------------------- | ---------------- |
| `unit`        | pure core + injected fakes        | nothing                   | < 5s total       |
| `integration` | one service against real Postgres | docker postgres, + estate | < 60s            |
| `smoke`       | whole compose stack, few tests    | full stack                | manual / nightly |

**One integration test reaches the live estate**, and it is deliberate: step 5's
`resolveTruthSource` is a claim about how 165 real WordPress hosts answer, and the plan
requires one test against them (`packages/truth/src/resolve.int.test.ts` — 11 requests at
1 req/s across three hosts, ~10s). Everything else in the tier needs only Postgres. Said
here because §5.1 below is the record of what a documented command actually needs.

**Every service must have a test entry point that runs without any other service.**
The crawler is testable without the API. The API is testable without the crawler —
seed Postgres from a fixture instead.

### 4.4 Determinism

No `Date.now()` or `Math.random()` in `core/`. Inject a clock and a seed. A test that
fails once a month at midnight UTC is worse than no test.

---

## 5. Tooling

| Concern    | Tool                                                     |
| ---------- | -------------------------------------------------------- |
| Lint       | ESLint 9 flat config + typescript-eslint, **type-aware** |
| Format     | Prettier                                                 |
| Test       | Vitest                                                   |
| Run TS     | tsx                                                      |
| Workspaces | npm workspaces                                           |

**Why not Biome.** Biome v2 does have type-aware rules via its opt-in Scanner, but
enabling it costs ~8s on 5k files against ~1s without, and it scans transitive
`node_modules` `.d.ts` files. The speed advantage disappears for exactly the rules we
need. pw-template already runs ESLint with `no-floating-promises` and `await-thenable`;
a second toolchain for the same rules, slower, is itself a YAGNI violation.

**`no-floating-promises` is non-negotiable here.** A crawler is almost entirely async,
and an unawaited promise is a silently dropped page — which under §1 is the worst
class of bug we have.

### 5.1 Commands

```
npm run lint              tsc --noEmit && eslint .    # types are part of linting
npm run format            prettier --write .
npm test                  unit tier — needs nothing
npm run test:integration  needs `docker compose up -d --wait` and, for one file, the
                          live estate (see §4.3)

npx link-graph crawl <site-id>            the product (step 7). Equivalently
npm run link-graph -- crawl <site-id>     needs Postgres migrated, a `sites` row for
                                          <site-id>, and network egress to that host
```

**Both forms of that last one are verified, and a bare `link-graph` is not.** The
workspace binary is a TypeScript file with a `#!/usr/bin/env tsx` shebang, so it runs
only where `tsx` resolves on PATH — which `npx` and `npm run` both arrange and a plain
shell does not. Measured 2026-08-24: `npx link-graph --help` exits 0;
`npx link-graph crawl nope` against an unmigrated database exits 2 with
`relation "sites" does not exist`; `DATABASE_URL=localhost:5432/x` exits 1. Recorded
here rather than only in the CLI's own help for the reason the paragraph below exists.

`pretest` runs `lint`, matching pw-template: a type or lint error fails before a
single test executes.

**Each tier is a config file, not a CLI filter.** `test:integration` was originally
written as `vitest run --include '**/*.int.test.ts'`. Vitest 2 has no `--include`
flag, so the command died with `CACError: Unknown option --include` from the first
commit until step 3 — a documented command that had never once been run. The tiers now
come from `vitest.config.ts` and `vitest.integration.config.ts`.

**The integration tier must fail, never skip.** Verified with Postgres stopped:
`npm test` passes 125 tests, `npm run test:integration` exits 1 with `ECONNREFUSED`
and a message naming the fix. A suite that skips when its dependency is missing is
§1's bug wearing a green tick.

---

## 6. Conventions

- **Named exports.** No default exports — they make renames invisible in review.
- **`type` imports explicit**: `import type { Site } from ...`
- **No `any`.** `unknown` plus a narrowing function. If a cast is truly needed, it
  carries a comment explaining why it is safe.
- **Errors carry context.** `No pages for ${siteId}: REST returned 0 and sitemap 404`
  beats `Error: no pages`.
- **Comments explain why, not what.** The pw-template comment quoted in §1 is the
  standard to aim for: it records the bug that motivated the code.
- **SQL lives in the db package**, not inlined in services.
- One file, one concern. If a file needs "and" to describe it, split it.
