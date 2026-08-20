-- Rollups and change over time. Populated by analyse (step 4) and diffs (step 13);
-- this migration only creates the tables the plan names.

-- Engineering guide §1: a partial crawl never produces metrics as though its page
-- set were the whole site, and a site with truth_source = 'none' reports
-- "undetectable" rather than zero orphans (PRD §2). Neither rule is expressible as a
-- CHECK here — the first spans two tables and the second needs a column analyse has
-- not designed yet — so both belong to step 4, and this note is where it finds them.
CREATE TABLE crawl_metrics (
  crawl_id     bigint PRIMARY KEY REFERENCES crawls (id) ON DELETE CASCADE,
  -- Exactly the counters PRD §7 names. Its trailing "..." is deliberate and belongs
  -- to step 4, which adds a further migration for whatever it actually computes —
  -- inventing columns here would guess at another step's output.
  orphans      integer NOT NULL,
  soft_orphans integer NOT NULL,
  excluded     integer NOT NULL,
  broken       integer NOT NULL,
  external     integer NOT NULL
);

CREATE TABLE crawl_diffs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_crawl_id  bigint NOT NULL REFERENCES crawls (id) ON DELETE CASCADE,
  to_crawl_id    bigint NOT NULL REFERENCES crawls (id) ON DELETE CASCADE,
  kind           text NOT NULL,
  url            text NOT NULL,
  detail         text
);

CREATE INDEX crawl_diffs_to_crawl_idx ON crawl_diffs (to_crawl_id);
