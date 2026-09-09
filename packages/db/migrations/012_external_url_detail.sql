-- Why an external check was inconclusive, in the checker's own words (PRD §6.1).
--
-- `003_external_urls.sql` gave this table `unverified`, and PRD §6.1 says what it is
-- for: "Third-party 429/403 is recorded as unverified, never as broken." What it could
-- not say was *why*, and engineering guide §1's last bullet is explicit that a
-- degradation has to be recorded in the row you write. Without this column every
-- inconclusive answer looks the same, and the two that look the same are the two a
-- reader most needs to tell apart:
--
--   * the destination host refused us — their bot protection, their rate limit;
--   * our own egress was broken — DNS, TLS, a proxy, no network at all.
--
-- The second one turns the whole table `unverified` in a single run, and because
-- `last_checked` is what the TTL reads, that run would then silence the checker for a
-- whole TTL window while looking exactly like a completed one. `linkcheckVerdict` in
-- packages/linkcheck refuses to write at all when no URL got a conclusive answer, which
-- catches the total outage; this column is what catches the partial one, where 40 of 642
-- failed and nobody can say whose fault it was.
ALTER TABLE external_urls ADD COLUMN detail text;

-- **You cannot write "we could not tell" without saying why.** An unverified row with
-- no detail is an unauditable shrug, and it is the shape a `catch` that swallowed its
-- error produces.
--
-- The IS NOT NULL is load-bearing and not belt-and-braces: a CHECK whose expression
-- evaluates to NULL *passes* in Postgres, so `NOT unverified OR btrim(detail, …) <> ''`
-- alone would accept detail = NULL — the exact row it exists to refuse. Measured on
-- postgres 18.6, 2026-09-02, by writing that form first and inserting the row.
--
-- The whitespace set is spelled out for the reason 011_finding_reviews.sql spells it
-- out: one-argument btrim strips spaces only, so `btrim(E'\t') = ''` is false.
ALTER TABLE external_urls ADD CONSTRAINT external_urls_unverified_has_detail
  CHECK (
    NOT unverified
    OR (detail IS NOT NULL AND btrim(detail, E' \t\n\r') <> '')
  );

-- No index. The read path is "which of this crawl's external URLs are due" — a join
-- from `links` onto this table's primary key, which the PK already serves, and then a
-- test on `last_checked` over the 642 rows that join produced (measured on
-- integrity.com's stored crawl). An index on `last_checked` would be for a scan of the
-- whole table that nothing performs; 003_external_urls.sql and 011_finding_reviews.sql
-- both decline the same way, for the same reason.
