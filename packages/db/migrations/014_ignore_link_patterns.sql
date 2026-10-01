-- docs/notes.md item 16: a per-site allowance for links that are noisy rather than
-- broken — a third-party tracker pixel that 403s every bot, a social share URL that
-- needs a session cookie to resolve. `ignore_paths` already exists but is the wrong
-- column: it excludes whole *pages* of this site from the orphan question (PRD §3), not
-- specific *link targets* from checking/counting wherever a link to them appears.
-- Scoped to the site whose links point at them, not to the (globally shared)
-- `external_urls` row itself: the same tracker URL linked from a second site, with no
-- config of its own, is still worth checking there.
ALTER TABLE sites ADD COLUMN ignore_link_patterns text[] NOT NULL DEFAULT '{}';
