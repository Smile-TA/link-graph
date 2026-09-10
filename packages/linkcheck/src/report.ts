/**
 * Reading lychee's JSON, and reconciling it against the URLs we asked about.
 *
 * **The reconciliation is not defensive programming; it is the measured behaviour.** Run
 * against integrity.com's real 642 external URLs, lychee 0.24.2:
 *
 * - **rewrote one URL before checking it.** `…/company/integrity-marketing.` was checked
 *   as `…/company/integrity-marketing`. lychee's input is a *document to extract links
 *   from*, not a list of URLs to check, so a trailing dot is sentence punctuation to it.
 * - **excluded one URL with no `--exclude` configured.** `https://twitter.com/IntegrityMG`
 *   comes back in `excluded_map` saying "This is due to your 'exclude' values".
 * - **dropped a URL from the output entirely** when handed a `tel:` URI — 12 in, `total`
 *   of 11, and no entry anywhere for the twelfth.
 *
 * Any of those three, joined on the echoed URL string, silently writes a row for a URL
 * nothing links to and leaves the real one permanently unchecked — a link that is never
 * checked and never reported as unchecked. So the join key is `span.line`, which is an
 * index into the exact list we wrote to stdin, and a URL the report does not account for
 * becomes an explicit `not-checked` outcome rather than an absence.
 */
import type { LinkOutcome } from "./verdict.js";

/** Which of lychee's four result maps an entry came from. */
export type LycheeMap = "success" | "error" | "timeout" | "excluded";

export interface LycheeEntry {
  /** The URL lychee reports having checked, which is not always the one requested. */
  readonly url: string;
  /** 1-based line of the input we wrote to its stdin. */
  readonly line: number;
  readonly map: LycheeMap;
  /** Absent for timeouts, exclusions and network failures; never invented. */
  readonly statusCode: number | null;
  readonly text: string;
}

export interface LycheeReport {
  /** lychee's own count of input occurrences. 11 when 12 URLs were handed in. */
  readonly total: number;
  readonly entries: readonly LycheeEntry[];
}

export interface LinkResult {
  /** The URL as requested — node identity, and the `external_urls` key. */
  readonly url: string;
  readonly outcome: LinkOutcome;
}

/** The four maps, and the outcome kind each one means. */
const MAPS: readonly (readonly [string, LycheeMap])[] = [
  ["success_map", "success"],
  ["error_map", "error"],
  ["timeout_map", "timeout"],
  ["excluded_map", "excluded"],
];

/**
 * lychee's stdout, or a refusal.
 *
 * **A refusal rather than an empty report, because exit codes cannot tell these apart.**
 * lychee exits 2 both for "at least one link failed" and — via clap — for an argument it
 * does not recognise, and the second prints nothing on stdout. A caller that trusted the
 * exit code would read a rejected flag as a clean run over zero links, which is the one
 * answer this package must never produce. So the JSON is the contract and anything else
 * throws.
 */
export function parseLycheeReport(stdout: string): LycheeReport {
  const body = parseJson(stdout);
  const total = body["total"];
  if (typeof total !== "number") {
    throw new Error(
      `lychee output has no numeric "total"; got ${describe(total)}. ` +
        `Expected the object \`--format json\` prints.`,
    );
  }
  const entries: LycheeEntry[] = [];
  for (const [key, map] of MAPS) {
    // A map is absent when empty, and `success_map` is also empty unless `--verbose` was
    // passed — measured: `detailed_stats` is false without it and every 200 is invisible,
    // which would make "checked and fine" indistinguishable from "never checked".
    const group = body[key];
    if (group === undefined) continue;
    for (const items of Object.values(asRecord(group, key))) {
      for (const item of asArray(items, key)) {
        entries.push(readEntry(item, map));
      }
    }
  }
  return { total, entries };
}

/**
 * One result per requested URL, in the order requested.
 *
 * The two refusals are about the join key itself rather than about one URL: a line
 * number outside the input, or two entries claiming the same line, mean the index we are
 * joining on does not describe the list we sent, and then every result is suspect.
 */
export function reconcile(
  requested: readonly string[],
  report: LycheeReport,
): LinkResult[] {
  const byLine = new Map<number, LycheeEntry>();
  for (const entry of report.entries) {
    if (
      !Number.isInteger(entry.line) ||
      entry.line < 1 ||
      entry.line > requested.length
    ) {
      throw new Error(
        `lychee reported on input line ${String(entry.line)} (${entry.url}), but only ` +
          `${String(requested.length)} URL(s) were sent. The line number is the only ` +
          `key back to the URL requested, so nothing in this report can be trusted.`,
      );
    }
    const clash = byLine.get(entry.line);
    if (clash !== undefined) {
      throw new Error(
        `lychee reported twice on input line ${String(entry.line)} (${clash.url} and ` +
          `${entry.url}); the line number is the join key and cannot name two results`,
      );
    }
    byLine.set(entry.line, entry);
  }

  return requested.map((url, index) => ({
    url,
    outcome: outcomeFor(url, byLine.get(index + 1)),
  }));
}

function outcomeFor(url: string, entry: LycheeEntry | undefined): LinkOutcome {
  if (entry === undefined) {
    return {
      kind: "not-checked",
      detail:
        `absent from the checker's report. Measured: lychee drops an input it does not ` +
        `recognise as a link, so it counted ${url} as neither checked nor excluded`,
    };
  }
  if (entry.url !== url) {
    return {
      kind: "not-checked",
      detail:
        `the checker rewrote it to ${entry.url} before requesting it, so the result ` +
        `(${entry.text}) is about a different URL`,
    };
  }
  if (entry.map === "excluded") return { kind: "refused-by-checker", detail: entry.text };
  if (entry.map === "timeout") return { kind: "timeout", detail: entry.text };
  if (entry.statusCode !== null) {
    return { kind: "status", statusCode: entry.statusCode };
  }
  // An error with no status code is DNS, TCP or TLS. Measured shapes: "Connection
  // refused - server may be down or port blocked", "Connection failed. Check network
  // connectivity and firewall settings" (a host with no DNS), "received corrupt message
  // of type InvalidContentType" (TLS onto a plaintext port).
  return { kind: "network", detail: entry.text };
}

function readEntry(item: unknown, map: LycheeMap): LycheeEntry {
  const entry = asRecord(item, `${map}_map entry`);
  const url = entry["url"];
  if (typeof url !== "string" || url === "") {
    throw new Error(`lychee ${map} entry has no url: ${JSON.stringify(item)}`);
  }
  const span = asRecord(entry["span"] ?? {}, "span");
  const line = span["line"];
  if (typeof line !== "number") {
    // Without a line there is no way back to the URL requested, and the echoed URL is
    // not a substitute — lychee rewrites it.
    throw new Error(`lychee ${map} entry for ${url} has no span.line`);
  }
  const status = asRecord(entry["status"] ?? {}, "status");
  const code = status["code"];
  const text = status["text"];
  const details = status["details"];
  return {
    url,
    line,
    map,
    statusCode: typeof code === "number" ? code : null,
    text: firstNonEmptyString(details, text),
  };
}

/** `status.details` when present, else `status.text`, else "" — first usable string. */
function firstNonEmptyString(...values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

function parseJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    throw new Error(
      "lychee produced no output on stdout. It exits 2 both for failed links and for " +
        "an argument it rejects, so an empty report is a failed invocation, not a " +
        "clean run.",
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`lychee output is not JSON (${trimmed.slice(0, 200)})`, {
      cause: error,
    });
  }
  return asRecord(body, "lychee output");
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`lychee ${what} is not an object: ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`lychee ${what} is not an array: ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value).slice(0, 120);
}
