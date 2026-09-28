-- A cross-host redirect on a site's root probe (docs/notes.md item 1:
-- askintegrity.com redirects to integrity.com/ask-integrity/) is not the same fact as
-- curation disabling a site: curation says "a human decided not to crawl this", a
-- redirect says "this hostname isn't independently hosting content at all, it's an
-- alias for another registered site." Conflating the two into the existing `enabled`
-- boolean would make a "deployed but unmonitored" drift-report entry (registry/drift.ts)
-- indistinguishable from an alias, and there is no queryable place today to record why
-- a site is disabled (curation.ts's `reason` field is a human comment in a checked-in
-- file, never written to the database).
--
-- Nullable, not a status enum: most sites never redirect, and `sync.ts` needs to be
-- able to clear this back to null on a later sync where the redirect has disappeared
-- (docs/05-improvement-plan.md's "re-probed on every sync" decision) without a status
-- transition table.
ALTER TABLE sites ADD COLUMN redirect_target_host text;

-- The same fact, but per-probe: `registry_health` is history (one row per sync run),
-- and without storing it here too, `listRegistryHealth`'s per-probe timeline would show
-- dnsOk/serves/platformSig flipping for a site whose real story is "started redirecting
-- to another host on 2026-09-20" — invisible without this column.
ALTER TABLE registry_health ADD COLUMN redirects_to_host text;
