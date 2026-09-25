import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("reads the one command there is", () => {
    expect(parseArgs(["crawl", "403bplan-net"])).toEqual({
      kind: "crawl",
      siteId: "403bplan-net",
      env: "prod",
    });
  });

  /** Step 14: staging is a flag on this same command, not a second one. */
  it("reads --stage as env: stage", () => {
    expect(parseArgs(["crawl", "403bplan-net", "--stage"])).toEqual({
      kind: "crawl",
      siteId: "403bplan-net",
      env: "stage",
    });
  });

  it("refuses --stage given twice", () => {
    expect(problem(parseArgs(["crawl", "403bplan-net", "--stage", "--stage"]))).toMatch(
      /--stage given twice/,
    );
  });

  it("asks for help three ways, as the first word", () => {
    for (const argv of [["--help"], ["-h"], ["help"]]) {
      expect(parseArgs(argv), argv.join(" ")).toEqual({ kind: "help" });
    }
  });

  /**
   * `--help` must not win from anywhere in argv. `link-graph crawl "$SITE"` with an
   * unset variable would otherwise print usage and exit 0 having crawled nothing — a
   * success code for a run that did not happen (engineering guide §1).
   */
  it("refuses --help in the site-id position rather than printing usage", () => {
    expect(problem(parseArgs(["crawl", "--help"]))).toMatch(/unknown option "--help"/);
  });

  it("refuses a help flag that swallows a real command", () => {
    // `link-graph --help crawl 403bplan-net` asked for a crawl. Printing usage and
    // exiting 0 would report success for a run that never happened.
    expect(problem(parseArgs(["--help", "crawl", "403bplan-net"]))).toMatch(
      /takes no other arguments/,
    );
  });

  it("refuses an empty invocation rather than doing something plausible", () => {
    const parsed = parseArgs([]);
    expect(parsed.kind).toBe("usage-error");
    expect(problem(parsed)).toMatch(/crawl <site-id>/);
  });

  it("refuses a crawl with no site id", () => {
    const parsed = parseArgs(["crawl"]);
    expect(parsed.kind).toBe("usage-error");
    expect(problem(parsed)).toMatch(/site id/i);
  });

  it("names an unknown command instead of guessing at it", () => {
    expect(problem(parseArgs(["analyse", "403bplan-net"]))).toMatch(/analyse/);
  });

  /**
   * A second positional is never a second site: one command, one site (step 7). Taking
   * the first and ignoring the rest is how someone runs `crawl a b` and reads the report
   * for `a` believing it covers both.
   */
  it("refuses extra arguments rather than ignoring them", () => {
    expect(problem(parseArgs(["crawl", "a", "b"]))).toMatch(/b/);
  });

  /** An unknown option must not be swallowed as the site id. */
  it("refuses an unknown option", () => {
    const parsed = parseArgs(["crawl", "--force"]);
    expect(parsed.kind).toBe("usage-error");
    expect(problem(parsed)).toMatch(/--force/);
  });

  it("refuses an option before the command as an unknown command", () => {
    // Not the same branch as the case above: this one never reaches the site id.
    const parsed = parseArgs(["--force", "crawl"]);
    expect(problem(parsed)).toMatch(/unknown command "--force"/);
  });
});

function problem(parsed: ReturnType<typeof parseArgs>): string {
  return parsed.kind === "usage-error"
    ? parsed.problem
    : `not a usage error: ${parsed.kind}`;
}

/**
 * `note` and `report` — step 7.6. The demo in the implementation plan is the first case
 * below, verbatim.
 */
describe("parseArgs: note", () => {
  it("reads the plan's demo invocation", () => {
    expect(
      parseArgs([
        "note",
        "integrity-com",
        "orphan",
        "/agents/thank-you/",
        "--intentional",
        "-m",
        "reached after form submit",
      ]),
    ).toEqual({
      kind: "note",
      siteId: "integrity-com",
      finding: "orphan",
      subject: "/agents/thank-you/",
      state: "intentional",
      note: "reached after form submit",
      by: null,
    });
  });

  it("takes the flags in any order, and --by when it is given", () => {
    expect(
      parseArgs([
        "note",
        "integrity-com",
        "broken_internal_link",
        "https://integrity.com/integrityidol/",
        "--by",
        "dave",
        "--message",
        "the campaign is over; the link is coming out",
        "--acknowledged",
      ]),
    ).toEqual({
      kind: "note",
      siteId: "integrity-com",
      finding: "broken_internal_link",
      subject: "https://integrity.com/integrityidol/",
      state: "acknowledged",
      note: "the campaign is over; the link is coming out",
      by: "dave",
    });
  });

  /**
   * PRD §7.1 rule 4. Somebody will type this, and the refusal is the one place the tool
   * can say why the state does not exist — a wrong "unknown option" would read as a
   * missing feature rather than as a decision.
   */
  it("refuses --fixed by naming the rule instead of the flag", () => {
    const parsed = parseArgs([
      "note",
      "integrity-com",
      "orphan",
      "/test/",
      "--fixed",
      "-m",
      "done",
    ]);
    expect(parsed.kind).toBe("usage-error");
    expect(problem(parsed)).toMatch(/no "fixed"/);
    expect(problem(parsed)).toMatch(/inbound link/);
  });

  /** Rule 3: the two states are two different claims, and one finding gets one. */
  it("refuses both states at once", () => {
    expect(
      problem(
        parseArgs([
          "note",
          "s",
          "orphan",
          "/x/",
          "--intentional",
          "--acknowledged",
          "-m",
          "n",
        ]),
      ),
    ).toMatch(/two different claims/);
  });

  it("refuses no state at all, rather than picking one", () => {
    expect(problem(parseArgs(["note", "s", "orphan", "/x/", "-m", "n"]))).toMatch(
      /--intentional/,
    );
  });

  /** PRD §2: a reviewed finding is one a human has judged *with a note*. */
  it("refuses a review with no note", () => {
    expect(problem(parseArgs(["note", "s", "orphan", "/x/", "--intentional"]))).toMatch(
      /needs -m <note>/,
    );
  });

  it("refuses a blank note", () => {
    expect(
      problem(parseArgs(["note", "s", "orphan", "/x/", "--intentional", "-m", "  "])),
    ).toMatch(/blank/);
  });

  /**
   * `-m --intentional` would otherwise store "--intentional" as the note and then refuse
   * the review for having no state — or worse, take a later `--acknowledged` and record
   * a judgement nobody made.
   */
  it("refuses an option where the note should be", () => {
    expect(
      problem(parseArgs(["note", "s", "orphan", "/x/", "-m", "--intentional"])),
    ).toMatch(/looks like an option/);
  });

  it("refuses -m at the end with nothing after it", () => {
    expect(
      problem(parseArgs(["note", "s", "orphan", "/x/", "--intentional", "-m"])),
    ).toMatch(/needs a note/);
  });

  it("names the finding kinds instead of guessing at one", () => {
    const parsed = parseArgs(["note", "s", "orphans", "/x/", "--intentional", "-m", "n"]);
    expect(problem(parsed)).toMatch(/orphans/);
    expect(problem(parsed)).toMatch(/broken_internal_link/);
  });

  it("refuses each missing positional by name", () => {
    expect(problem(parseArgs(["note"]))).toMatch(/site id/);
    expect(problem(parseArgs(["note", "s"]))).toMatch(/finding kind/);
    expect(problem(parseArgs(["note", "s", "orphan"]))).toMatch(/subject/);
  });

  it("refuses an option in a positional slot rather than reviewing a site called --x", () => {
    expect(problem(parseArgs(["note", "--intentional", "orphan", "/x/"]))).toMatch(
      /unknown option "--intentional"/,
    );
  });

  it("refuses an extra positional after the options begin", () => {
    expect(
      problem(
        parseArgs(["note", "s", "orphan", "/x/", "--intentional", "-m", "n", "extra"]),
      ),
    ).toMatch(/unexpected argument "extra"/);
  });

  it("refuses a duplicated note rather than keeping one of the two", () => {
    expect(
      problem(
        parseArgs(["note", "s", "orphan", "/x/", "--intentional", "-m", "a", "-m", "b"]),
      ),
    ).toMatch(/twice/);
  });
});

describe("parseArgs: report", () => {
  it("reads a site id", () => {
    expect(parseArgs(["report", "integrity-com"])).toEqual({
      kind: "report",
      siteId: "integrity-com",
    });
  });

  it("refuses a report with no site id", () => {
    expect(problem(parseArgs(["report"]))).toMatch(/site id/);
  });

  it("refuses options and extra arguments", () => {
    expect(problem(parseArgs(["report", "--all"]))).toMatch(/--all/);
    expect(problem(parseArgs(["report", "a", "b"]))).toMatch(/unexpected argument "b"/);
  });
});

describe("parseArgs: registry", () => {
  it("reads sync and report, with no site id", () => {
    expect(parseArgs(["registry", "sync"])).toEqual({ kind: "registry-sync" });
    expect(parseArgs(["registry", "report"])).toEqual({ kind: "registry-report" });
  });

  it("refuses registry with no subcommand", () => {
    expect(problem(parseArgs(["registry"]))).toMatch(/sync or report/);
  });

  it("refuses an unknown registry subcommand", () => {
    expect(problem(parseArgs(["registry", "bogus"]))).toMatch(
      /unknown registry subcommand "bogus"/,
    );
  });

  it("refuses an extra argument after the subcommand", () => {
    expect(problem(parseArgs(["registry", "sync", "extra"]))).toMatch(
      /unexpected argument "extra"/,
    );
  });
});

describe("parseArgs: migrate", () => {
  it("reads migrate, with no arguments", () => {
    expect(parseArgs(["migrate"])).toEqual({ kind: "migrate" });
  });

  it("refuses an extra argument", () => {
    expect(problem(parseArgs(["migrate", "extra"]))).toMatch(/unexpected argument "extra"/);
  });
});
