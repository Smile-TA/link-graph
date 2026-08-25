import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("reads the one command there is", () => {
    expect(parseArgs(["crawl", "403bplan-net"])).toEqual({
      kind: "crawl",
      siteId: "403bplan-net",
    });
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
