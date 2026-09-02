-- Review state (PRD §7.1): a finding a human has already judged, with a note.
--
-- Step 7's gate produced 529 correct findings on integrity.com and 16 of them are
-- correct *and* intentional — 8 form thank-you pages and 8 campaign landing pages
-- (PRD §2, decided 2026-09-02). A reader who cannot say "I have judged this one" reads
-- the same list every week and stops reading it, which is PRD §2's opening sentence
-- arriving through a different door.
--
-- Nothing in this table is ever read by `analyse`. It joins at read time, and PRD §7.1
-- rule 1 is why: a review must never change a measured number. `crawl_metrics` and
-- `pages.class` stay exactly as the crawl recorded them, so a report where every orphan
-- has been reviewed reads "538 orphans, 538 reviewed" and never "no orphans" — a
-- suppressed finding that is indistinguishable from an absent one is engineering guide
-- §1 pointing the wrong way.

-- Every text column below is checked non-blank against an **explicit** whitespace set.
-- Measured on postgres 18.6, 2026-09-02: one-argument `btrim` strips spaces and nothing
-- else — `btrim(E'\t') = ''` is false — so the obvious `btrim(note) <> ''` accepts a
-- tab-only note and a newline-only one. The CLI's own refusal uses JS `.trim()`, which
-- does strip both, so this is the copy that has to hold for step 11's API and for a
-- hand-written `psql` fix-up. It is not a Unicode-complete test (a non-breaking space
-- passes, measured): it is the backstop that keeps an unauditable blank judgement out.
CREATE TABLE finding_reviews (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The surrogate sites.id, as crawls.site_id is; see the note in 001_sites.sql on the
  -- deliberate type split. ON DELETE CASCADE from `sites` and — deliberately — from
  -- nothing else: a review outlives the crawl whose findings prompted it.
  site_id         bigint NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  -- Phase 1's two kinds. The other copy of this vocabulary is FINDING_KINDS in
  -- packages/db/src/repo/finding-reviews.ts, and packages/review's digest table is
  -- `satisfies Record<FindingKind, …>` over it, so a third kind is a compile error
  -- before it is a constraint violation.
  kind            text NOT NULL CHECK (kind IN ('orphan', 'broken_internal_link')),
  -- The url_normalized the finding is ABOUT: the orphaned page, or a broken link's
  -- target. Never its blast radius, which is a set of pages that changes crawl to crawl
  -- (PRD §7.1 rule 2). Non-blank like every other text column here: it is the key the
  -- whole table rests on, and a blank one would be a review of nothing.
  subject         text NOT NULL CHECK (btrim(subject, E' \t\n\r') <> ''),
  -- Two states, both meaning "do not rank this as new", differing in what they claim
  -- (PRD §7.1 rule 3): `intentional` = unlinked by design, `acknowledged` = a real
  -- defect, seen, not fixed yet. Collapsing them into one "dismissed" would throw away
  -- the only number a reader gets out of the exercise — how much of the backlog is
  -- deliberate versus outstanding.
  --
  -- **There is no `fixed`, and this CHECK is where that is enforced** (PRD §7.1 rule
  -- 4). A fixed orphan gains an inbound link and the next crawl stops reporting it; a
  -- hand-written "fixed" would let a stale human claim outrank a live measurement.
  state           text NOT NULL CHECK (state IN ('intentional', 'acknowledged')),
  -- Required, and required non-blank: PRD §2 defines a reviewed finding as one "a human
  -- has already judged, WITH a note". A row with no note ranks a finding out of the
  -- new list while recording no reason, which is the state that makes a year-old
  -- dismissal unauditable.
  note            text NOT NULL CHECK (btrim(note, E' \t\n\r') <> ''),
  -- What was true when the review was written (PRD §7.1 rule 5). When current evidence
  -- differs the finding reports as `changed since review` and ranks with the new ones,
  -- so an acknowledged 404 linked from 18 pages does not stay quiet once it is linked
  -- from 40. The tuple it is taken over lives in packages/review — deliberately not in
  -- SQL, because it is policy and re-computed on every read.
  evidence_digest text NOT NULL CHECK (btrim(evidence_digest, E' \t\n\r') <> ''),
  -- `--by` or $USER. No auth in phase 1 (step 11 can tighten it), and no default:
  -- an anonymous judgement is one nobody can ask about.
  reviewed_by     text NOT NULL CHECK (btrim(reviewed_by, E' \t\n\r') <> ''),
  -- Every review prints its age next to the finding, which is what keeps a two-year-old
  -- acknowledgement visible while §7.1's disappeared-then-returned gap stays open until
  -- step 13. No DEFAULT now(): the clock is injected at the boundary (guide §4.4).
  reviewed_at     timestamptz NOT NULL,
  -- Identity, and the whole point of the table (PRD §7.1 rule 2). `pages` and `links`
  -- rows belong to one crawl and are rolled up after twelve of them (PRD §7), so a note
  -- keyed on a crawl-scoped row id would evaporate on schedule.
  UNIQUE (site_id, kind, subject)
);

-- No further index: the read path is "every review for this site and kind", which is a
-- leading-column prefix of the unique key above.
