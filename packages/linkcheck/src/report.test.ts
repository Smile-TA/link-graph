/**
 * Parsing and reconciling one real lychee run.
 *
 * The fixture is verbatim stdout from lychee 0.24.2 with the URL list it was given
 * (test/fixtures/README.md records the command). Three of its twelve lines are the
 * reason this file exists, and none of the three was imagined: one URL was rewritten
 * before being checked, one was excluded by a rule nobody configured, and one is absent
 * from the output altogether.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseLycheeReport, reconcile } from "./report.js";

const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)),
    "utf8",
  );

const MIXED = fixture("lychee-mixed.json");
const REQUESTED = fixture("lychee-mixed-input.txt")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "");

const byUrl = (url: string) => {
  const results = reconcile(REQUESTED, parseLycheeReport(MIXED));
  const found = results.find((result) => result.url === url);
  if (found === undefined) throw new Error(`no result for ${url}`);
  return found;
};

describe("parseLycheeReport", () => {
  it("reads every entry of a real run, across all four maps", () => {
    const report = parseLycheeReport(MIXED);
    // 12 URLs were handed in; lychee reports on 11 of them.
    expect(report.total).toBe(11);
    expect(report.entries).toHaveLength(11);
    expect(new Set(report.entries.map((entry) => entry.map))).toEqual(
      new Set(["success", "error", "timeout", "excluded"]),
    );
  });

  /**
   * A bad flag makes lychee exit 2 — the same code as "some links failed" — and print a
   * clap error to stderr with nothing on stdout. Trusting the exit code would read that
   * as a clean run of zero links; the JSON is what has to be trusted.
   */
  it.each([
    ["empty output", ""],
    ["a clap error", "error: unexpected argument '--nope' found"],
    ["truncated JSON", '{"total": 3, "success_map":'],
  ])("refuses %s rather than reporting no links", (_label, output) => {
    expect(() => parseLycheeReport(output)).toThrow(/lychee/i);
  });

  it.each([
    ["no total", '{"success_map":{}}'],
    ["a total that is not a number", '{"total":"3","success_map":{}}'],
    ["an entry with no url", '{"total":1,"success_map":{"stdin":[{"span":{"line":1}}]}}'],
    [
      "an entry with no span",
      '{"total":1,"success_map":{"stdin":[{"url":"https://x/"}]}}',
    ],
  ])("refuses output with %s", (_label, output) => {
    expect(() => parseLycheeReport(output)).toThrow();
  });
});

describe("reconcile", () => {
  it("returns one result per requested URL, in the order requested", () => {
    const results = reconcile(REQUESTED, parseLycheeReport(MIXED));
    expect(results).toHaveLength(REQUESTED.length);
    expect(results.map((result) => result.url)).toEqual(REQUESTED);
  });

  it("maps a 200 and a followed redirect to the status lychee ended on", () => {
    expect(byUrl("http://127.0.0.1:8799/live/").outcome).toEqual({
      kind: "status",
      statusCode: 200,
    });
    // /moved/ is a 301 to /live/. lychee follows it and reports 200 — so the recorded
    // status describes where the link lands, which is what a visitor experiences.
    expect(byUrl("http://127.0.0.1:8799/moved/").outcome).toEqual({
      kind: "status",
      statusCode: 200,
    });
  });

  it("maps error-map entries with a code to that status", () => {
    expect(byUrl("http://127.0.0.1:8799/gone/").outcome).toEqual({
      kind: "status",
      statusCode: 404,
    });
    expect(byUrl("http://127.0.0.1:8799/forbidden/").outcome).toEqual({
      kind: "status",
      statusCode: 403,
    });
  });

  it("maps a codeless error to a network failure and a timeout to a timeout", () => {
    const refused = byUrl("http://127.0.0.1:1/refused/").outcome;
    expect(refused.kind).toBe("network");
    expect(refused).toHaveProperty(
      "detail",
      expect.stringContaining("Connection refused"),
    );
    expect(byUrl("http://127.0.0.1:8799/hang/").outcome.kind).toBe("timeout");
  });

  /**
   * Measured, and not a hypothetical: `https://twitter.com/IntegrityMG` is one of
   * integrity.com's 642 real external URLs, and lychee excludes it with **no
   * `--exclude` configured**, reporting "This is due to your 'exclude' values". An
   * excluded URL was never requested from anyone, so it cannot be a pass.
   */
  it("treats a URL the checker excluded on its own as unverified, not as a pass", () => {
    const outcome = byUrl("https://twitter.com/IntegrityMG").outcome;
    expect(outcome.kind).toBe("refused-by-checker");
  });

  /**
   * Measured on the real 642: `https://www.linkedin.com/company/integrity-marketing.`
   * comes back as `…/integrity-marketing` — lychee extracts links from text, so a
   * trailing dot is punctuation to it. A check of a different URL is not a check of
   * this one, and joining on the echoed string would have written a row for a URL
   * nothing links to while leaving the real one permanently unchecked.
   */
  it("refuses to accept a result for a URL that is not the one requested", () => {
    const outcome = byUrl("http://127.0.0.1:8799/ok.").outcome;
    expect(outcome.kind).toBe("not-checked");
    expect(outcome).toHaveProperty(
      "detail",
      expect.stringContaining("http://127.0.0.1:8799/ok"),
    );
  });

  /** `tel:+15551234567` is in the input and nowhere in the output. 12 in, 11 reported. */
  it("accounts for a URL the report leaves out entirely", () => {
    const outcome = byUrl("tel:+15551234567").outcome;
    expect(outcome.kind).toBe("not-checked");
    expect(outcome).toHaveProperty("detail", expect.stringMatching(/report/i));
  });

  it("leaves no requested URL without an outcome", () => {
    const results = reconcile(REQUESTED, parseLycheeReport(MIXED));
    expect(results.filter((r) => r.outcome.kind === "not-checked")).toHaveLength(2);
    expect(results.every((r) => r.outcome.kind.length > 0)).toBe(true);
  });

  /**
   * A line number outside the input is lychee describing an input we did not give it,
   * which means the join key is wrong and every result is suspect. That is a refusal,
   * not a per-URL degradation.
   */
  it.each([0, 13, -1])("refuses a report citing input line %i", (line) => {
    const report = {
      total: 1,
      entries: [
        { url: "https://x/", line, map: "success" as const, statusCode: 200, text: "" },
      ],
    };
    expect(() => reconcile(REQUESTED, report)).toThrow(/line/i);
  });

  it("refuses a report that names the same input line twice", () => {
    const entry = {
      url: "http://127.0.0.1:8799/live/",
      line: 1,
      map: "success" as const,
      statusCode: 200,
      text: "200 OK",
    };
    expect(() => reconcile(REQUESTED, { total: 2, entries: [entry, entry] })).toThrow(
      /line 1/i,
    );
  });
});
