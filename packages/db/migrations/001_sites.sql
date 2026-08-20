-- Registry: the estate as deployment-configurations declares it, plus the curation
-- overlay (PRD §3). Forward-only: never edit an applied file, add a new one.

CREATE TABLE sites (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The registry slug (an app directory name in deployment-configurations).
  site_id         text NOT NULL UNIQUE,
  canonical_host  text NOT NULL,
  -- Every host serving this site, canonical_host included. Declarative, from
  -- ingress.entries[].hosts[].hostname — 145 of 312 prod hostnames are www. aliases,
  -- and without them every www. link is a phantom external node (PRD §3).
  aliases         text[] NOT NULL DEFAULT '{}',
  stage_host      text,
  enabled         boolean NOT NULL DEFAULT true,
  -- NULL means "not resolved yet"; 'none' means "resolved, and there is no truth
  -- source". Collapsing the two would let an unresolved site report 0 orphans, which
  -- PRD §2 calls Undetectable and forbids reporting as zero.
  truth_source    text CHECK (truth_source IN ('rest', 'sitemap', 'none')),
  crawler_mode    text NOT NULL DEFAULT 'http'
                    CHECK (crawler_mode IN ('http', 'playwright')),
  -- Requests per second for this host. Default 1.0 (PRD §5.1, measured).
  rate_limit      double precision NOT NULL DEFAULT 1.0,
  ignore_paths    text[] NOT NULL DEFAULT '{}'
);

-- Liveness history (PRD §3.1). One row per probe, so drift over time is visible:
-- a registered host that stops being platform-served is a finding, not a deletion.
CREATE TABLE registry_health (
  -- The surrogate sites.id, not the sites.site_id slug. The types differ on purpose:
  -- joining this to sites.site_id is then a type error rather than an empty result.
  site_id       bigint NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  checked_at    timestamptz NOT NULL,
  dns_ok        boolean NOT NULL,
  serves        boolean NOT NULL,
  platform_sig  boolean NOT NULL,
  version_txt   text,
  PRIMARY KEY (site_id, checked_at)
);
