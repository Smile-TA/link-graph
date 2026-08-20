-- What analyse (step 4) writes. Two things 004_metrics.sql deferred to this file by
-- name: the `pages.class` vocabulary, and a `crawl_metrics` shape that can express
-- PRD §2's Undetectable rather than reporting zero orphans for a site nobody can check.

-- The closed vocabulary of pages.class, whose other copy is PAGE_CLASSES in
-- packages/db/src/repo/pages.ts. NULL still passes, and that is the point: NULL means
-- "analyse has not run", which a reader must be able to tell apart from "analysed, and
-- nothing was found".
ALTER TABLE pages ADD CONSTRAINT pages_class_known CHECK (
  class IN ('linked', 'soft_orphan', 'orphan', 'excluded',
            'not_in_truth_source', 'undetectable'));

-- --- crawl_metrics ---------------------------------------------------------------
--
-- Every column below exists because its absence would let a failure read as a clean
-- result (engineering guide §1). The new columns are NOT NULL with no default: nothing
-- has ever written this table, so there is no row to backfill, and a DEFAULT left
-- behind would let a future INSERT that forgot a counter record a plausible zero. On a
-- table that somehow does have rows this migration fails loudly, which is the outcome
-- §1 asks for.

-- Orphan detection is a set difference against an inventory. A site with no truth
-- source has no inventory, so its orphan counters are unknown — NULL, in SQL's own
-- vocabulary for it — and never zero (PRD §2, Undetectable). The CHECK keeps the two
-- counters together: one known and the other not is a bookkeeping bug, and a reader who
-- sums `orphans` across the estate has to be able to find the unknowns with one
-- predicate.
ALTER TABLE crawl_metrics ALTER COLUMN orphans DROP NOT NULL;
ALTER TABLE crawl_metrics ALTER COLUMN soft_orphans DROP NOT NULL;
ALTER TABLE crawl_metrics ADD CONSTRAINT crawl_metrics_orphans_known_together CHECK (
  (orphans IS NULL) = (soft_orphans IS NULL));

-- The remaining page classes, so that the six counters account for every page of the
-- crawl. A classification pass that silently skipped pages otherwise produces a row
-- that looks like a small clean site.
ALTER TABLE crawl_metrics ADD COLUMN linked integer NOT NULL;
ALTER TABLE crawl_metrics ADD COLUMN not_in_truth_source integer NOT NULL;
ALTER TABLE crawl_metrics ADD COLUMN undetectable integer NOT NULL;

-- Pages with no path from the homepage over any internal link. A superset of the
-- orphans, and the difference is a finding in itself: a page can have an inbound
-- contextual edge and still be unreachable, because the page linking to it is.
ALTER TABLE crawl_metrics ADD COLUMN unreachable integer NOT NULL;

-- Internal edges whose target this crawl never fetched. Measured in step 3: 439 of 452
-- internal edges on the six captures. Those targets are UNKNOWN, never broken — and
-- without this counter beside it, `broken = 0` reads as "no broken internal links"
-- when it means "13 of 452 were actually checked".
ALTER TABLE crawl_metrics ADD COLUMN internal_unresolved integer NOT NULL;

-- The N that soft_orphans was computed at (PRD §6, §15). soft_orphans is a function of
-- it, so a stored row without it cannot be compared with the next one — and N is still
-- unresolved, so it will change.
ALTER TABLE crawl_metrics ADD COLUMN boilerplate_threshold_pct double precision NOT NULL
  CHECK (boilerplate_threshold_pct > 0 AND boilerplate_threshold_pct <= 100);
