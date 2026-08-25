-- Sampling, as its own axis (PRD §15, settled 2026-08-20; column shape amended
-- 2026-08-24).
--
-- agent.familyfirstlife.com is 59,363 pages that are one page with a per-agent
-- substitution, so crawling it exhaustively buys nothing for 16.5 hours of request
-- budget at the measured 1 req/s. Such a site is crawled to a ceiling instead.
--
-- §15 originally wrote this as `crawler_mode = 'sample'`. crawler_mode is *which
-- fetcher* — http or playwright (PRD §5) — and sampling is *how much of the site*;
-- a third value there would make "sample a Playwright site" unrepresentable, and the
-- two facts are independent. So crawler_mode is left exactly as it was.
ALTER TABLE sites ADD COLUMN crawl_scope text NOT NULL DEFAULT 'full'
  CHECK (crawl_scope IN ('full', 'sample'));

-- The ceiling is NULL for a site crawled in full, so it cannot have a default.
ALTER TABLE sites ADD COLUMN sample_ceiling integer CHECK (sample_ceiling > 0);

-- The pairing is the point. `sample` with no ceiling is a full crawl wearing the
-- label — it would run to 59,363 pages while the crawl reported itself sampled, and
-- its orphan count would be suppressed as NULL for a crawl that actually covered the
-- site. A ceiling on a `full` site is a limit nothing enforces, which is worse than no
-- limit because it reads like one. Neither state can be written down.
ALTER TABLE sites ADD CONSTRAINT sites_sample_ceiling_iff_sample CHECK (
  (crawl_scope = 'sample') = (sample_ceiling IS NOT NULL));

-- What this does NOT add: a per-crawl copy of the scope. The scope is a property of
-- the site's policy at the time of the crawl, and duplicating it onto `crawls` would
-- create two answers to "was this a sample" that drift the first time the policy
-- changes. `crawl_metrics.orphans_unknown_reason` already records the consequence on
-- the crawl itself (007), which is the fact a report needs.
