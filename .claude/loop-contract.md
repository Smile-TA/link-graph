# Build-out loop contract

How one step of `docs/03-implementation-plan.md` gets built. The orchestrator runs one
iteration per step; a fresh subagent does the work and must pass both gates below
before handing back.

## Roles

|                  |                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| **Subagent**     | Implements exactly one step. Runs both gates. Never commits.                                                 |
| **Orchestrator** | Picks the step, verifies the work independently, commits, marks the step done, schedules the next iteration. |

The orchestrator **re-runs the tests and reads the diff itself**. A subagent's report
is a claim, not evidence — engineering guide §1 applies to agents as much as to code.

## Required reading, every iteration

- `docs/02-engineering-guide.md` — all of it, especially §1 (a failure must never look
  like a success), §2.1 (what YAGNI does not mean), §4 (layering, injection, tiers)
- `docs/03-implementation-plan.md` — the step being built, and its ordering rules
- The PRD sections the step cites
- `~/.claude/CLAUDE.md`

## Implementation rules

1. **TDD, and prove it.** Write the tests first, run them, and **observe them fail for
   the intended reason** before writing the implementation. Report the failure list.
   A test that passes the moment it is written tested nothing.
2. **Fixtures come from the real estate**, never invented. Capture at **1 req/s**
   (PRD §5.1 — Wordfence returns 503 above ~8 req/s and bans the IP for an hour).
   Check fixtures in; unit tests never touch the network.
3. **Verify assumptions against reality before encoding them.** Both bugs found in
   step 1 were rules that looked obviously right and were measured wrong. If the code
   assumes a server behaves a certain way, fetch it once and confirm.
4. **Scope is the step.** Do not start the next one. Do not refactor adjacent code
   that the step does not touch.
5. `npm test` (which runs lint first) must pass. No `eslint-disable` without a comment
   saying why.

## Hard stop conditions — halt and report, do not decide

- The step requires resolving an open item in **PRD §15**. Those are the user's calls.
  The cross-estate link identity question lands in step 3/4 and is exactly this case.
- A measurement contradicts the PRD or the plan.
- The step cannot be completed without also changing an earlier step's committed
  behaviour.
- Anything needing a live crawl beyond fixture capture, or any write to
  `deployment-configurations` (read-only upstream, never open a PR against it).

Halting with a clear reason is a success. Guessing past one of these is the failure
mode this contract exists to prevent.

## Gate 1 — simplify

Invoke the `simplify` skill if it exists in the session. If it does not, do this pass
directly:

- Remove what the step does not need. Inline single-use indirection. Collapse
  near-duplicate branches. Delete dead parameters and speculative options.
- Behaviour must not change: the full suite passes before and after, unchanged.
- Anything still complex needs a comment saying why, or it comes out.

## Gate 2 — review

Invoke the `code-review` skill if it exists in the session. Note that the marketplace
version is PR-based and will not work here — this repo has no remote. If the skill is
absent or PR-bound, do this pass directly against `git diff HEAD`:

Review the diff along five independent lines, then score every finding for confidence
0–100 and **act only on those ≥ 80** (rubric from the official code-review command):

| Line of attack   | Looking for                                                                |
| ---------------- | -------------------------------------------------------------------------- |
| Guide adherence  | violations of engineering guide §1–§6 and `CLAUDE.md`                      |
| Bugs in the diff | real defects in changed lines only, no nitpicks                            |
| Silent failure   | any path where a failure could return a plausible-looking success          |
| Test honesty     | tests that would still pass if the implementation were wrong               |
| Assumptions      | encoded beliefs about server or library behaviour that were never measured |

| Score | Meaning                           |
| ----- | --------------------------------- |
| 0     | False positive, or pre-existing   |
| 25    | Might be real, unverified         |
| 50    | Real but a nitpick                |
| 75    | Verified, will be hit in practice |
| 100   | Confirmed, will happen frequently |

Not findings: pre-existing issues, style a linter would catch, missing coverage of
things outside the step, pedantry a senior engineer would not raise.

Fix every finding ≥ 80, then **re-run both gates**. Converged when simplify changes
nothing and review returns no finding ≥ 80. **Cap at three rounds** — if it has not
converged by then, stop and report what is still outstanding rather than churning.

## Handing back

Report, in this order:

1. What was built, and the seam it exposes
2. The failing-test list observed before implementing
3. Gate 1 and Gate 2 results per round, including findings dismissed below 80 and why
4. **Anything measured that contradicts a doc** — this is the highest-value output
5. What was deliberately left undone
6. Test and lint status, verbatim

No commits. No edits to `docs/03-implementation-plan.md` step status — the orchestrator
marks steps done after verifying.
