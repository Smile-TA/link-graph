/**
 * Turning one run's results into the rows to write and the numbers to print.
 *
 * Pure, and the numbers are the §1 surface: a reader who sees "1 broken" has to be able
 * to tell whether that was 1 of 642 checked or 1 of 3, and whether the other 639 were
 * fresh or unanswerable.
 */
import { describe, expect, it } from "vitest";
import { summariseResults } from "./summary.js";
import type { LinkResult } from "./report.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

const RESULTS: LinkResult[] = [
  { url: "https://a.example.org/", outcome: { kind: "status", statusCode: 200 } },
  { url: "https://b.example.org/", outcome: { kind: "status", statusCode: 404 } },
  { url: "https://c.example.org/", outcome: { kind: "status", statusCode: 403 } },
  { url: "https://d.example.org/", outcome: { kind: "timeout", detail: "Timeout" } },
];

describe("summariseResults", () => {
  it("writes one row per result, stamped with the injected clock", () => {
    const { rows } = summariseResults(RESULTS, NOW);
    expect(rows).toHaveLength(RESULTS.length);
    expect(rows.map((row) => row.urlNormalized)).toEqual(RESULTS.map((r) => r.url));
    expect(
      rows.every((row) => row.lastChecked?.toISOString() === NOW.toISOString()),
    ).toBe(true);
  });

  it("partitions the results into ok, broken and unverified, adding up to checked", () => {
    const { counts } = summariseResults(RESULTS, NOW);
    expect(counts).toEqual({
      checked: 4,
      ok: 1,
      broken: 1,
      unverified: 2,
      conclusive: 2,
    });
    expect(counts.ok + counts.broken + counts.unverified).toBe(counts.checked);
  });

  it("counts an empty run as four zeros rather than as nothing", () => {
    expect(summariseResults([], NOW)).toEqual({
      rows: [],
      counts: { checked: 0, ok: 0, broken: 0, unverified: 0, conclusive: 0 },
    });
  });

  /**
   * The row a 403 produces: the status the host gave, `unverified` so it never reaches a
   * broken-link report, and a detail saying why — which the SQL CHECK in
   * `012_external_url_detail.sql` also insists on.
   */
  it("keeps a blocked host's status code while marking the row unverified", () => {
    const { rows } = summariseResults([RESULTS[2] as LinkResult], NOW);
    const row = rows[0];
    expect({ ...row, detail: undefined }).toEqual({
      urlNormalized: "https://c.example.org/",
      lastChecked: NOW,
      statusCode: 403,
      unverified: true,
      detail: undefined,
    });
    expect(row?.detail).toMatch(/403/);
  });
});
