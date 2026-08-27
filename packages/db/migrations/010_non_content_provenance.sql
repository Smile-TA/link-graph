-- Where a URL came from in the CMS, so PRD §2's Excluded class can see it.
--
-- `pages.post_type` has existed since 002 and was NULL for all 2,454 rows of the
-- integrity.com crawl of 2026-08-25, because nothing populated it. Step 5 knew the post
-- type of every REST URL and discarded the child sitemap's name for every sitemap URL;
-- step 6 recorded null and said so. The cost is measured twice: ~10% of
-- tidewatermg.com's sitemap is non-content (86 bricks_template, 164 taxonomy archives,
-- 4 author archives), and integrity.com's live run reported 9 taxonomy archives among
-- its 538 orphans. Unclassified, those are phantom orphans in front of a reader, and
-- PRD §13 puts orphan false positives first on the list of things that destroy trust.

-- The frontier is the only thing that survives between seeding a crawl and writing a
-- page row. A resumed crawl has no seed list — it went with the process that held it —
-- so the post type has to live beside `in_truth_source`, for the same reason 009 gives
-- for that column.
--
-- NULL means "no source named one": a flat sitemap.xml, or a URL the crawl discovered
-- rather than inherited. It must never be read as content or as non-content, only as
-- unknown, and `classifyPage` treats it as neither.
ALTER TABLE crawl_frontier ADD COLUMN post_type text;

COMMENT ON COLUMN crawl_frontier.post_type IS
  'What the truth source named this URL: a WordPress post type slug, a taxonomy slug '
  'for an archive, or ''author''. NULL = no source named one.';

COMMENT ON COLUMN pages.post_type IS
  'What the truth source named this URL: a WordPress post type slug, a taxonomy slug '
  'for an archive, or ''author''. Wider than the column name suggests, because a '
  'taxonomy or author archive has no post type and still needs its provenance recorded '
  '(PRD §4). NULL = no source named one, which is never read as content and never as '
  'non-content.';

-- The site's taxonomy vocabulary as this crawl resolved it (PRD §4: "Rules are
-- per-site"). It is what turns a post type into the Excluded decision: `category` and
-- `insights_category` are taxonomy archives on integrity.com, `team-department` is one
-- on tidewatermg.com and nothing on integrity.com, and no closed list of names could
-- know either. WordPress declares it, per post type, in the /wp-json/wp/v2/types
-- response the resolver already fetches.
--
-- On `crawls` rather than `sites` because it must match the run that produced the
-- post types beside it: `analyse` can be re-run over an old crawl, and a vocabulary
-- that had moved on since would reclassify pages nobody re-crawled.
--
-- Empty is not "this site has no taxonomies" — it is "no name is known here", which is
-- what a site whose REST could not be read gives. An empty vocabulary excludes nothing, which is the
-- direction that leaves a finding in the report rather than deleting one.
ALTER TABLE crawls ADD COLUMN taxonomies text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN crawls.taxonomies IS
  'Every taxonomy the site declared when this crawl was seeded, read from its '
  '/wp-json/wp/v2/types response. Empty = no name is known, which excludes nothing.';

-- Both columns store EVIDENCE, and neither stores the verdict. Which types count as
-- non-content is policy, and policy lives in `classifyPage` (packages/analyse) where it
-- is a pure function under the unit tier: re-running `analyse` over a crawl recorded
-- today applies whatever the rule has become, and the page-builder list will grow as
-- new sites turn up. Freezing the verdict here instead would mean a crawl could only
-- ever be classified by the code that made it.
