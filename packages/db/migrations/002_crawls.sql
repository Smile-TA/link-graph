-- One crawl of one site, the pages it saw, and the edges between them (PRD §7).

CREATE TABLE crawls (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Surrogate sites.id; see the note in 001_sites.sql on the deliberate type split.
  site_id        bigint NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  env            text NOT NULL DEFAULT 'prod' CHECK (env IN ('prod', 'stage')),
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz,
  -- A crawl that ended early — Wordfence block, timeout, kill — is 'partial' and
  -- never 'complete' (engineering guide §1). Only 'complete' may produce metrics
  -- and diffs as though the page set were the whole site.
  status         text NOT NULL CHECK (status IN ('running', 'complete', 'partial')),
  -- image.tag from the registry at crawl time: release attribution without CI
  -- integration (PRD §8).
  deployed_tag   text,
  registry_sha   text,
  pages_seen     integer NOT NULL DEFAULT 0,
  was_throttled  boolean NOT NULL DEFAULT false
);

CREATE TABLE pages (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  crawl_id         bigint NOT NULL REFERENCES crawls (id) ON DELETE CASCADE,
  -- Node identity, from core's normalizeUrl. Absolute, canonical host.
  url_normalized   text NOT NULL,
  -- Root-relative path including query — the pw-template convention, which makes
  -- prod/stage comparison a string compare (PRD §7).
  path             text NOT NULL,
  post_type        text,
  -- NULL means the page was never fetched (transport error, or a frontier entry a
  -- partial crawl never reached). It must never be read as 200.
  status_code      integer,
  -- Click depth from the homepage. NULL until analyse (step 4) computes it.
  depth            integer,
  in_truth_source  boolean NOT NULL,
  indexable        boolean NOT NULL,
  canonical_to     text,
  redirect_to      text,
  -- Orphan classification. NULL means "not classified yet"; the vocabulary belongs
  -- to analyse (step 4), so this column deliberately carries no CHECK yet.
  class            text,
  -- Node identity within a crawl. Two rows for one URL would double an inbound
  -- count and split a page's edges in half.
  UNIQUE (crawl_id, url_normalized),
  -- Redundant against the primary key, and there so that links can carry a
  -- composite foreign key — see the note on links.crawl_id below.
  UNIQUE (crawl_id, id)
);

CREATE TABLE links (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Denormalized from pages.crawl_id so that step 4's aggregates can filter links
  -- without a join. The composite foreign keys at the bottom of this table make the
  -- denormalization enforced rather than merely intended: an edge attributed to the
  -- wrong crawl would otherwise be invisible, and would quietly change that crawl's
  -- inbound counts. No direct reference to crawls: pages already has one, and a third
  -- referential check on the largest table in the schema would buy nothing.
  crawl_id           bigint NOT NULL,
  from_page_id       bigint NOT NULL,
  to_url_normalized  text NOT NULL,
  -- The page in THIS crawl that to_url_normalized names, when there is one. NULL for
  -- an external target, and for an internal target the crawl never fetched.
  to_page_id         bigint,
  anchor             text NOT NULL,
  -- The rel attribute exactly as written; nofollow is a token inside it.
  rel                text,
  is_external        boolean NOT NULL,
  -- NULL until analyse (step 4) marks it. A DEFAULT false would make every edge of
  -- an un-analysed crawl look contextual, and so report zero soft orphans — a wrong
  -- answer that reads as good news (engineering guide §1).
  is_boilerplate     boolean,
  -- Outermost landmark ancestor of the <a>, from core's extractPage. Closed
  -- vocabulary so step 4 can GROUP BY it to calibrate the boilerplate threshold.
  container          text NOT NULL CHECK (
                       container IN ('header', 'footer', 'nav', 'aside',
                                     'main', 'article', 'body')),
  -- Position in the page's <a href> sequence. A logo linked from the header and
  -- again from the footer is two edges, and this is what keeps them distinct.
  dom_index          integer NOT NULL,
  UNIQUE (crawl_id, from_page_id, dom_index),
  FOREIGN KEY (crawl_id, from_page_id)
    REFERENCES pages (crawl_id, id) ON DELETE CASCADE,
  -- MATCH SIMPLE (the default): when to_page_id is null the constraint is not
  -- checked, which is exactly the "target this crawl never fetched" case.
  --
  -- CASCADE, not SET NULL: deleting one page therefore also deletes the edges
  -- pointing AT it, reducing some other page's out-degree. That is why retention
  -- (step 13) deletes whole crawls and never individual pages.
  FOREIGN KEY (crawl_id, to_page_id)
    REFERENCES pages (crawl_id, id) ON DELETE CASCADE
);

-- Inbound counts and the depth CTE (step 4) walk edges by target within one crawl.
CREATE INDEX links_crawl_to_page_idx ON links (crawl_id, to_page_id);
-- Boilerplate marking keys on the target URL, including targets never fetched.
CREATE INDEX links_crawl_target_idx ON links (crawl_id, to_url_normalized);
