/**
 * The command line, as a pure function. Three commands, one site each: crawl the site
 * (step 7), judge one of its findings, or re-read its last crawl (step 7.6). No queue,
 * no multi-site run.
 *
 * **Every unrecognised word is a refusal rather than something ignored.** `crawl a b`
 * taking `a` and dropping `b` is how someone reads a report for one site believing it
 * covers two, and `--dry-run` swallowed as a site id is a crawl of a site called
 * `--dry-run`. `crawl` and `report` take no options at all, so an option-shaped argument
 * is always a mistake there; `note` takes four, and every way of getting them wrong
 * that would otherwise store a judgement nobody made is refused by name below.
 */
import { FINDING_KINDS, REVIEW_STATES } from "@link-graph/db";
import type { FindingKind, ReviewState } from "@link-graph/db";

export type Invocation =
  | { readonly kind: "crawl"; readonly siteId: string }
  | {
      readonly kind: "note";
      readonly siteId: string;
      /** Which kind of finding, not this invocation's kind. */
      readonly finding: FindingKind;
      /** As typed: a path or an absolute URL. Node identity is resolved later. */
      readonly subject: string;
      readonly state: ReviewState;
      readonly note: string;
      /** `null` = fall back to `$USER`, which only the process knows. */
      readonly by: string | null;
    }
  | { readonly kind: "report"; readonly siteId: string }
  | { readonly kind: "registry-sync" }
  | { readonly kind: "registry-report" }
  | { readonly kind: "help" }
  | { readonly kind: "usage-error"; readonly problem: string };

const HINT =
  "usage: link-graph crawl <site-id> | note <site-id> <kind> <subject> " +
  "--intentional|--acknowledged -m <note> | report <site-id> | " +
  "registry sync|report (see --help)";

/**
 * The state flags are generated from the vocabulary rather than written out, so a third
 * `REVIEW_STATES` value arrives with a flag instead of being unreachable from the CLI.
 */
const STATE_FLAGS = new Map<string, ReviewState>(
  REVIEW_STATES.map((state) => [`--${state}`, state]),
);

export function parseArgs(argv: readonly string[]): Invocation {
  const [command] = argv;
  // Help is the WHOLE invocation or nothing. Letting `--help` win from anywhere in argv
  // — or letting it swallow the words after it — means `link-graph $FLAGS crawl "$SITE"`
  // with a leftover flag prints usage and exits 0 having crawled nothing: a success code
  // for a run that did not happen, which is engineering guide §1 in the one signal a
  // cron job reads.
  if (command === "--help" || command === "-h" || command === "help") {
    return argv.length === 1
      ? { kind: "help" }
      : usageError(`${quote(command)} takes no other arguments`);
  }
  if (command === undefined) return usageError("no command given");
  if (command === "crawl" || command === "report") return oneSite(command, argv);
  if (command === "note") return note(argv);
  if (command === "registry") return registry(argv);
  return usageError(`unknown command ${quote(command)}`);
}

/** `crawl <site-id>` and `report <site-id>`: one positional, no options, no extras. */
function oneSite(command: "crawl" | "report", argv: readonly string[]): Invocation {
  const [, siteId, extra] = argv;
  if (siteId === undefined) return usageError(`${command} needs a site id`);
  if (siteId.startsWith("-")) {
    return usageError(`unknown option ${quote(siteId)} — this command takes no options`);
  }
  if (extra !== undefined) {
    return usageError(
      `unexpected argument ${quote(extra)} — ${command} takes one site id`,
    );
  }
  return { kind: command, siteId };
}

/**
 * `note <site-id> <kind> <subject> --intentional|--acknowledged -m <note> [--by <who>]`.
 *
 * Three positionals, then flags in any order. Everything below refuses rather than
 * defaults, because the thing being written down is a person's judgement: a state
 * guessed, a note lost to a swallowed flag or a second `-m` silently winning would all
 * store a review somebody did not write, and it would then rank a real finding out of
 * the new list for as long as the evidence holds.
 */
function note(argv: readonly string[]): Invocation {
  const [, siteId, finding, subject, ...flags] = argv;
  if (siteId === undefined) return usageError("note needs a site id");
  if (finding === undefined) {
    return usageError(`note needs a finding kind after ${quote(siteId)}`);
  }
  if (subject === undefined) {
    return usageError(`note needs a subject after ${quote(finding)}`);
  }
  // An option in a positional slot is never a value: `note --intentional orphan /x/`
  // would otherwise review a site called `--intentional`.
  for (const value of [siteId, finding, subject]) {
    if (value.startsWith("-")) return usageError(`unknown option ${quote(value)}`);
  }
  if (!isFindingKind(finding)) {
    return usageError(
      `unknown finding kind ${quote(finding)} — one of ${FINDING_KINDS.join(", ")}`,
    );
  }

  let state: ReviewState | null = null;
  let message: string | null = null;
  let by: string | null = null;
  // A cursor rather than an index, so that a flag which takes a value consumes it by
  // reading the cursor once — `flags[index + 1]` plus a manual `index += 1` is the same
  // thing with two places to forget.
  let cursor = 0;
  const next = (): string | undefined => flags[cursor++];
  for (let flag = next(); flag !== undefined; flag = next()) {
    const wanted = STATE_FLAGS.get(flag);
    if (wanted !== undefined) {
      if (state !== null) {
        return usageError(
          state === wanted
            ? `${flag} given twice`
            : `--${state} and ${flag} are two different claims about one finding ` +
                `(PRD §7.1) — give one`,
        );
      }
      state = wanted;
      continue;
    }
    // PRD §7.1 rule 4, said in the one place a person will look for it. "Unknown
    // option" would read as a missing feature rather than as a decision.
    if (flag === "--fixed") {
      return usageError(
        `there is no "fixed" review state (PRD §7.1): a fixed orphan gains an inbound ` +
          `link and the next crawl stops reporting it, so a hand-written "fixed" would ` +
          `outrank the measurement. Use --acknowledged until it is fixed`,
      );
    }
    if (flag === "-m" || flag === "--message" || flag === "--by") {
      const value = next();
      const what = flag === "--by" ? "a name" : "a note";
      if (value === undefined) return usageError(`${flag} needs ${what}`);
      // `-m --intentional` would otherwise store "--intentional" as the note, and a
      // note that ate the state flag is a review with no claim in it.
      if (value.startsWith("-")) {
        return usageError(
          `${flag} needs ${what}, and ${quote(value)} looks like an option`,
        );
      }
      if (value.trim() === "") return usageError(`${flag} cannot be blank`);
      if (flag === "--by") {
        if (by !== null) return usageError(`--by given twice`);
        by = value;
      } else {
        if (message !== null) return usageError(`the note was given twice`);
        message = value;
      }
      continue;
    }
    return usageError(
      flag.startsWith("-")
        ? `unknown option ${quote(flag)}`
        : `unexpected argument ${quote(flag)} — note takes a site id, a finding kind ` +
            `and a subject, then its options`,
    );
  }

  if (state === null) {
    return usageError(
      `note needs --intentional (unlinked by design) or --acknowledged (a real defect, ` +
        `seen, not fixed yet) — the two are different claims and the split is the ` +
        `number a reader gets out of reviewing (PRD §7.1)`,
    );
  }
  if (message === null) {
    return usageError(
      `note needs -m <note>: a reviewed finding is one a human has judged *with a ` +
        `note* (PRD §2), and a dismissal with no reason is one nobody can audit`,
    );
  }
  return { kind: "note", siteId, finding, subject, state, note: message, by };
}

/**
 * `registry sync` and `registry report` (step 9): no site id, no options — the whole
 * estate, every time. Same refusal shape as `oneSite`: an extra word is a mistake to
 * name, not a value to drop.
 */
function registry(argv: readonly string[]): Invocation {
  const [, sub, extra] = argv;
  if (sub === undefined) return usageError("registry needs sync or report");
  if (sub !== "sync" && sub !== "report") {
    return usageError(`unknown registry subcommand ${quote(sub)} — sync or report`);
  }
  if (extra !== undefined) {
    return usageError(`unexpected argument ${quote(extra)} — registry ${sub} takes none`);
  }
  return { kind: sub === "sync" ? "registry-sync" : "registry-report" };
}

function isFindingKind(value: string): value is FindingKind {
  // Widened to `readonly string[]` only so `.includes` accepts an arbitrary word: the
  // vocabulary's own element type would refuse the very argument being tested.
  return (FINDING_KINDS as readonly string[]).includes(value);
}

const usageError = (problem: string): Invocation => ({
  kind: "usage-error",
  problem: `${problem}. ${HINT}`,
});

const quote = (value: string): string => JSON.stringify(value);
