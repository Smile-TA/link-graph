-- The soft-orphan class comes out (PRD §2, decided 2026-08-20), and `orphans IS NULL`
-- learns to say why.
--
-- Two measurements killed the class, neither of them a coding error. It produced a
-- false positive on real data: /contact-us/ on 403bplan.net has two genuine in-content
-- links whose anchor text matches the header nav entry, so the (target, anchor) pair
-- sat on 13/13 pages, both edges were marked boilerplate, and the page came out a soft
-- orphan. And the verdict moved with the crawler's URL-admission policy: adding that
-- site's 17 internal PDF links to the same crawl took the nav pairs from 100% to 43%
-- of pages fetched and turned all three of its soft orphans into `linked`. A class
-- that flips on which requests a crawler chose to make cannot carry a report.
--
-- True orphans are untouched: zero inbound edges means no frequency threshold enters
-- the verdict.

-- Lossless, not destructive. A page classified `soft_orphan` had inbound edges by
-- definition, and the new rule is "any inbound edge means linked" — so this UPDATE is
-- the reclassification, not an approximation of it. Written before the CHECK changes
-- so that a row the constraint would reject cannot survive the migration.
UPDATE pages SET class = 'linked' WHERE class = 'soft_orphan';

ALTER TABLE pages DROP CONSTRAINT pages_class_known;
ALTER TABLE pages ADD CONSTRAINT pages_class_known CHECK (
  class IN ('linked', 'orphan', 'excluded', 'not_in_truth_source', 'undetectable'));

-- --- crawl_metrics ---------------------------------------------------------------

-- The pairing CHECK from 005_analysis.sql exists only to keep the two orphan counters
-- null together, and there is about to be one counter.
ALTER TABLE crawl_metrics DROP CONSTRAINT crawl_metrics_orphans_known_together;
ALTER TABLE crawl_metrics DROP COLUMN soft_orphans;

-- Why `orphans IS NULL` now needs a reason beside it. Two different facts produce it —
-- "this site has no truth source, so there is no inventory to difference against"
-- (PRD §2, Undetectable) and "this crawl was a sample by policy, so absence of a link
-- proves nothing" (PRD §15) — and they have different remedies: one is a content
-- decision, the other is how we chose to crawl 59,363 templated pages. A bare NULL
-- cannot say which, and a reader who cannot tell them apart is back to engineering
-- guide §1's failure that reads like a result.
ALTER TABLE crawl_metrics ADD COLUMN orphans_unknown_reason text
  CHECK (orphans_unknown_reason IN ('no_truth_source', 'sampled'));

-- An equivalence, not two one-way checks: a NULL count with no reason is unexplained,
-- and a reason beside a real count claims the number is unknown while showing it.
-- Neither can be written down, so there is no third state for a later step to forget.
ALTER TABLE crawl_metrics ADD CONSTRAINT crawl_metrics_orphans_null_has_reason CHECK (
  (orphans IS NULL) = (orphans_unknown_reason IS NOT NULL));

-- boilerplate_threshold_pct stays, with a smaller job. It is no longer the N a page
-- class depends on — with soft orphans gone, N cannot change any page's class — but it
-- is still the N a stored is_boilerplate was computed at, which PRD §9's section matrix
-- reads and step 13 compares across crawls.
COMMENT ON COLUMN crawl_metrics.boilerplate_threshold_pct IS
  'N (PRD §6) that links.is_boilerplate was computed at for this crawl. Since '
  '2026-08-20 a display parameter, not a correctness-critical one: no page class '
  'depends on it.';
