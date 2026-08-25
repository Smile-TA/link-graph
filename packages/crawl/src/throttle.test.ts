import { describe, expect, it } from "vitest";
import { isThrottled, retryAfterSeconds } from "./throttle.js";

describe("isThrottled", () => {
  it("recognises the measured Wordfence block", () => {
    // PRD §5.1: 503 at ~8 req/s sustained on whyaim.com, first block at request ~155.
    expect(isThrottled(503)).toBe(true);
  });

  it("recognises 429, the RFC 6585 code for the same condition", () => {
    expect(isThrottled(429)).toBe(true);
  });

  it("does not treat an ordinary failure as a block", () => {
    // A 500 is this page failing; a 404 is this page missing. Stopping the host for
    // either would abandon a crawl over one bad page, and resuming would never help.
    for (const status of [200, 301, 404, 410, 500, 502, 504]) {
      expect([status, isThrottled(status)]).toEqual([status, false]);
    }
  });
});

describe("retryAfterSeconds", () => {
  const now = new Date("2026-08-20T12:00:00Z");

  it("reads the measured Wordfence value", () => {
    expect(retryAfterSeconds("3600", now)).toBe(3600);
  });

  it("reads the HTTP-date form", () => {
    // RFC 9110 allows either form; nothing in the estate has been seen using the date
    // form, so it is handled rather than assumed absent.
    expect(retryAfterSeconds("Thu, 20 Aug 2026 12:30:00 GMT", now)).toBe(1800);
  });

  it("is null when the header is absent, so a caller cannot read zero as 'retry now'", () => {
    expect(retryAfterSeconds(undefined, now)).toBeNull();
    expect(retryAfterSeconds("", now)).toBeNull();
    expect(retryAfterSeconds("soon", now)).toBeNull();
  });

  it("clamps a date already in the past to zero rather than returning a negative wait", () => {
    expect(retryAfterSeconds("Thu, 20 Aug 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("refuses a negative numeric value", () => {
    expect(retryAfterSeconds("-1", now)).toBeNull();
  });
});
