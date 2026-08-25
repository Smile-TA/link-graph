-- The crawl frontier: which URLs a crawl still owes a page row (step 6, PRD §5.0/§5.1).
--
-- Why it is a table and not an in-memory queue. Measured 2026-08-18 on whyaim.com:
-- Wordfence bans the source IP for **one hour** on the first 503. A block 1,800 pages
-- into a 3,000-page crawl must pause that host and continue later — it must not restart,
-- and it must not throw away the 1,800 rows already written. Engineering guide §2.1 lists
-- resumable crawl state as the case where deferring the work is not YAGNI but a rewrite
-- of the crawler's loop later, so it ships with the crawler.
--
-- Resume is then a SELECT: the rows with no fetched_at, oldest first.

CREATE TABLE crawl_frontier (
  -- Insertion order, and therefore fetch order. Deterministic, which is what makes two
  -- runs of the same crawl produce the same page set in the same sequence — the
  -- plan's done-criterion for this step.
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  crawl_id         bigint NOT NULL REFERENCES crawls (id) ON DELETE CASCADE,
  -- Node identity, from core's normalizeUrl, exactly as pages.url_normalized stores it.
  url_normalized   text NOT NULL,
  -- True for the truth source's own URLs and false for everything discovered while
  -- crawling. It is carried here rather than derived later because it is an input to
  -- the orphan set difference (PRD §2) and the seed list is gone by the time the page
  -- is fetched — on a resumed crawl, gone with the process that held it.
  in_truth_source  boolean NOT NULL,
  -- NULL means this URL still owes a page row. Set in the same transaction as the
  -- INSERT into pages, so a killed worker can never leave one without the other.
  fetched_at       timestamptz,
  -- How many times a fetch of this URL has been attempted, across resumes. A URL whose
  -- attempts climb while it stays pending is a permanently failing page, and without
  -- the counter a scheduler would retry it forever with nothing to show for it.
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  -- One frontier entry per URL per crawl. Two would fetch the page twice and then fail
  -- the (crawl_id, url_normalized) unique constraint on pages, halfway through a crawl.
  UNIQUE (crawl_id, url_normalized),
  -- A fetched row carries no error: the error is cleared when the page row lands, so
  -- "failed and still pending" and "succeeded on a later attempt" cannot be confused.
  CONSTRAINT crawl_frontier_error_means_pending CHECK (
    fetched_at IS NULL OR last_error IS NULL)
);

-- The crawl loop's only read: the next URL owing a page row. Partial, because the
-- fetched rows are the overwhelming majority by the end of a 3,000-page crawl and none
-- of them is ever selected again.
CREATE INDEX crawl_frontier_pending_idx ON crawl_frontier (crawl_id, id)
  WHERE fetched_at IS NULL;
