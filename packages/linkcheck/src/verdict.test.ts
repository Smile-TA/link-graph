/**
 * The §1 tests of this package: every way a check can fail to be an answer.
 *
 * An external link checker's characteristic bug is reporting someone else's bot
 * protection as your broken link, so the table below is the specification. Each row is
 * a shape measured from lychee 0.24.2 (see test/fixtures/README.md) or a status code
 * PRD §6.1 names, and the assertion is always the same one: it is `unverified`, and it
 * says why.
 */
import { describe, expect, it } from "vitest";
import {
  externalUrlVerdict,
  isBrokenExternal,
  linkcheckVerdict,
  type LinkOutcome,
} from "./verdict.js";

const status = (statusCode: number): LinkOutcome => ({ kind: "status", statusCode });

describe("externalUrlVerdict", () => {
  it("records a 200 as verified, with nothing to explain", () => {
    expect(externalUrlVerdict(status(200))).toEqual({
      statusCode: 200,
      unverified: false,
      detail: null,
    });
  });

  /**
   * PRD §6.1: the crawler fetches every internal page, so a broken internal link is a
   * join. An external one is a claim about someone else's server, and 404 and 410 are
   * the only two answers that claim the resource is absent rather than describing our
   * request or their mood.
   */
  it.each([404, 410])("records %i as broken, because it names the resource", (code) => {
    const verdict = externalUrlVerdict(status(code));
    expect(verdict).toEqual({ statusCode: code, unverified: false, detail: null });
    expect(isBrokenExternal(verdict)).toBe(true);
  });

  /**
   * The list PRD §6.1 mandates (429/403) plus the ones that mean the same thing: an
   * answer about our access or their capacity, not about the link. Every one of these
   * is a finding somebody chases if it lands in a broken-link report.
   */
  it.each([401, 403, 405, 406, 407, 409, 418, 429, 451, 500, 502, 503, 504])(
    "records %i as unverified rather than broken",
    (code) => {
      const verdict = externalUrlVerdict(status(code));
      expect(verdict.statusCode).toBe(code);
      expect(verdict.unverified).toBe(true);
      expect(verdict.detail).toMatch(/\S/);
      expect(isBrokenExternal(verdict)).toBe(false);
    },
  );

  /** Measured shapes with no status code at all — lychee reports no `status.code`. */
  it.each<[string, LinkOutcome]>([
    [
      "a TLS handshake failure",
      { kind: "network", detail: "Network error: received corrupt message" },
    ],
    [
      "a dead host",
      // agents.integrity.com has no DNS (PRD §3.1); lychee 0.24.2 answers with this.
      { kind: "network", detail: "Connection failed. Check network connectivity" },
    ],
    ["a timeout", { kind: "timeout", detail: "Request timed out" }],
    [
      "a URL the checker refused to check",
      { kind: "refused-by-checker", detail: "Excluded" },
    ],
    [
      "a URL the checker never reported on",
      { kind: "not-checked", detail: "absent from the report" },
    ],
  ])("records %s as unverified with no status code", (_label, outcome) => {
    const verdict = externalUrlVerdict(outcome);
    expect(verdict.statusCode).toBeNull();
    expect(verdict.unverified).toBe(true);
    expect(verdict.detail).toMatch(/\S/);
    expect(isBrokenExternal(verdict)).toBe(false);
  });

  /**
   * The invariant the SQL CHECK in 012_external_url_detail.sql also enforces, asserted
   * here over every outcome kind so that a kind added later cannot slip through with a
   * null detail and be refused only at write time.
   */
  it("never returns unverified without a detail, for any outcome", () => {
    const outcomes: LinkOutcome[] = [
      status(200),
      status(404),
      status(403),
      status(503),
      { kind: "network", detail: "x" },
      { kind: "timeout", detail: "x" },
      { kind: "refused-by-checker", detail: "x" },
      { kind: "not-checked", detail: "x" },
    ];
    for (const outcome of outcomes) {
      const verdict = externalUrlVerdict(outcome);
      if (verdict.unverified) expect(verdict.detail).toMatch(/\S/);
      else expect(verdict.detail).toBeNull();
    }
  });

  /** The detail is the checker's own words, not a paraphrase a reader cannot search. */
  it("carries the checker's own message into the detail", () => {
    const verdict = externalUrlVerdict({
      kind: "network",
      detail: "Connection refused - server may be down or port blocked",
    });
    expect(verdict.detail).toContain("Connection refused - server may be down");
  });
});

describe("linkcheckVerdict", () => {
  it("calls a run that answered at least one URL complete", () => {
    expect(linkcheckVerdict({ checked: 3, conclusive: 1 })).toEqual({
      status: "complete",
      stoppedBecause: null,
    });
  });

  it("calls a run with nothing due complete, because nothing was owed", () => {
    expect(linkcheckVerdict({ checked: 0, conclusive: 0 })).toEqual({
      status: "complete",
      stoppedBecause: null,
    });
  });

  /**
   * The shape of our own egress being broken: every URL comes back "we could not tell".
   * It must not be written, because `last_checked` is what the TTL reads — a run that
   * learned nothing would otherwise silence the checker for a whole TTL window while
   * reporting zero broken links.
   */
  it("calls a run where nothing could be told partial, and says so", () => {
    const verdict = linkcheckVerdict({ checked: 642, conclusive: 0 });
    expect(verdict.status).toBe("partial");
    expect(verdict.stoppedBecause).toContain("642");
    expect(verdict.stoppedBecause).toMatch(/egress|network/i);
  });
});
