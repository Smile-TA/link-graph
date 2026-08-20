-- What step 5's truth-source resolution records, and the hole in step 4 it closes.
--
-- Step 4 left `analyse` unable to tell a complete crawl from a token one: the four
-- step-3 captures reported `orphans: 0` for sites holding 1,953 and 989 sitemap URLs,
-- because nothing said how large the inventory was. A one-page crawl of integrity.com
-- read as a clean bill of health — engineering guide §1's opening example, in a new
-- place. Orphan detection is a set difference against an inventory, so the size of that
-- inventory is part of the result, not context.

-- Three counts, because the two sources disagree in both directions and the
-- disagreement is itself a finding (PRD §4). Measured 2026-08-20 on integrity.com's
-- `page` post type: WP REST lists 124 published pages and `page-sitemap.xml` lists 96
-- of them.
--
-- NULL means "that source was not available", never zero. A count of zero would be an
-- inventory of nothing, which engineering guide §1 forbids recording as an answer, so
-- the CHECKs below refuse it outright.
ALTER TABLE crawls ADD COLUMN truth_source_urls integer;
ALTER TABLE crawls ADD COLUMN truth_source_rest_urls integer;
ALTER TABLE crawls ADD COLUMN truth_source_sitemap_urls integer;

-- PRD §2's `sitemap-invisible` — present in WP REST, absent from the sitemap — is
--     truth_source_urls - truth_source_sitemap_urls
-- and its mirror is `truth_source_urls - truth_source_rest_urls`. Arithmetic on the
-- union, so there is no fourth column to fall out of step with the other three, and the
-- answer is NULL rather than 0 for any crawl where the two sources were not both read.
-- That is the property PRD §13 asks for: never a zero nobody measured.
ALTER TABLE crawls ADD CONSTRAINT crawls_truth_source_urls_positive CHECK (
  (truth_source_urls IS NULL OR truth_source_urls > 0)
  AND (truth_source_rest_urls IS NULL OR truth_source_rest_urls > 0)
  AND (truth_source_sitemap_urls IS NULL OR truth_source_sitemap_urls > 0));

-- The union is known exactly when at least one source was read, and it lies between
-- the larger of the two and their sum. A row that breaks this is a bookkeeping bug, and
-- the coverage refusal in `analyse` divides by the first column.
ALTER TABLE crawls ADD CONSTRAINT crawls_truth_source_counts_agree CHECK (
  (truth_source_urls IS NULL)
    = (truth_source_rest_urls IS NULL AND truth_source_sitemap_urls IS NULL)
  AND (truth_source_urls IS NULL OR (
    truth_source_urls >= greatest(coalesce(truth_source_rest_urls, 0),
                                  coalesce(truth_source_sitemap_urls, 0))
    AND truth_source_urls <= coalesce(truth_source_rest_urls, 0)
                             + coalesce(truth_source_sitemap_urls, 0))));

-- `unreachable`: a fourth value for a column PRD §3 gives three.
--
-- 'none' means "we asked, and this site has no inventory" — orphan detection is
-- impossible and the remedy is a content decision. A host that never answers has told
-- us nothing: `agents.integrity.com` has no DNS and `integritymedicarehelpline.com`
-- refuses connections (PRD §3.1), and both still hold live pw-template configs.
-- Recording those as 'none' files a broken deployment as a permanently unmonitorable
-- site; leaving NULL claims nobody has looked yet. Both are wrong in a way no report
-- would show. `hasTruthSource` in packages/analyse tests for 'rest' or 'sitemap'
-- positively, so this value cannot be mistaken for an inventory.
ALTER TABLE sites DROP CONSTRAINT sites_truth_source_check;
ALTER TABLE sites ADD CONSTRAINT sites_truth_source_check CHECK (
  truth_source IN ('rest', 'sitemap', 'none', 'unreachable'));
