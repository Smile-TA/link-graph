/**
 * `main` on the paths that reach no database: help, and every way of getting the
 * invocation wrong. The crawl path is `crawl-command.int.test.ts`, which needs Postgres
 * and the fixture server.
 */
import { describe, expect, it } from "vitest";
import { EXIT } from "./exit.js";
import { describeError, main } from "./main.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
  };
}

/**
 * The two error shapes whose own `message` is not a diagnosis. Measured 2026-08-24: a
 * refused connection to the default `DATABASE_URL` arrives as an `AggregateError` with an
 * empty message, and before this the whole report of a down database was `link-graph: `.
 */
describe("describeError", () => {
  it("reads the detail out of an AggregateError, which has none of its own", () => {
    const refused = new AggregateError([
      new Error("connect ECONNREFUSED ::1:5432"),
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
    ]);
    expect(refused.message).toBe("");
    expect(describeError(refused)).toBe(
      "connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432",
    );
  });

  it("keeps both halves of a wrapped error", () => {
    const wrapped = new Error("cannot create the test database", {
      cause: new Error("password authentication failed"),
    });
    expect(describeError(wrapped)).toBe(
      "cannot create the test database: password authentication failed",
    );
  });

  it("falls back to the name of an Error with no message at all", () => {
    expect(describeError(new RangeError())).toBe("RangeError");
    expect(describeError("boom")).toBe("boom");
  });
});

describe("main", () => {
  it("prints usage on --help and succeeds", async () => {
    const io = capture();
    expect(await main(["--help"], io.io)).toBe(0);
    expect(io.stdout()).toMatch(/link-graph crawl <site-id>/);
    // The exit codes are part of the command's contract, so they are documented where
    // the person running it will look.
    expect(io.stdout()).toMatch(/Exit codes/);
    expect(io.stderr()).toBe("");
  });

  it("refuses an empty invocation without touching a database", async () => {
    const io = capture();
    expect(await main([], io.io)).toBe(EXIT.usage);
    expect(io.stderr()).toMatch(/crawl <site-id>/);
    // Nothing on stdout: a caller piping the report to a file must not get half of one.
    expect(io.stdout()).toBe("");
  });

  it("refuses an unknown command", async () => {
    const io = capture();
    expect(await main(["orphans", "403bplan-net"], io.io)).toBe(EXIT.usage);
    expect(io.stderr()).toMatch(/orphans/);
    expect(io.stdout()).toBe("");
  });

  /**
   * A `DATABASE_URL` that cannot be used is the commonest misconfiguration there is, and
   * it is a usage error rather than a failed run: nothing was crawled and the fix is in
   * the environment. Needs no database — `databaseUrl` refuses the string itself.
   */
  it("refuses an unusable DATABASE_URL as a usage error", async () => {
    const io = capture();
    const code = await main(["crawl", "403bplan-net"], {
      ...io.io,
      env: { DATABASE_URL: "localhost:5432/link_graph" },
    });
    expect(code).toBe(EXIT.usage);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("localhost:5432/link_graph");
  });

  /**
   * The §1 case: usage on stdout with exit 0 for an invocation that crawled nothing.
   * Reaching a database is not needed to prove it — the refusal happens in argv.
   */
  it("does not treat a --help in the site-id position as a successful run", async () => {
    const io = capture();
    expect(await main(["crawl", "--help"], io.io)).toBe(EXIT.usage);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toMatch(/unknown option/);
  });
});
