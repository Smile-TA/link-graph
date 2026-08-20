-- External link status, shared across all sites and keyed by URL, not by site
-- (PRD §6.1). A destination linked from 40 sites is checked once. This table is the
-- source of truth and owns the TTL; lychee's own .lycheecache stays disabled.

CREATE TABLE external_urls (
  url_normalized  text PRIMARY KEY,
  -- NULL means never checked. The TTL policy reads this column; a NULL must not be
  -- read as "checked long ago and fine".
  last_checked    timestamptz,
  status_code     integer,
  -- A host that blocks us (429/403) is unverified, never broken (PRD §6.1).
  unverified      boolean NOT NULL DEFAULT false
);
