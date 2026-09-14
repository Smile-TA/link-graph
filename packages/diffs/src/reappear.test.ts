import { describe, expect, it } from "vitest";
import { reappearedSince } from "./reappear.js";

const at = (isoDate: string) => new Date(isoDate);

describe("reappearedSince", () => {
  it("is false with no history", () => {
    expect(reappearedSince([], at("2026-01-01"))).toBe(false);
  });

  it("is false for a resolve with no later appearance", () => {
    const events = [{ subject: "/a/", kind: "resolved" as const, at: at("2026-02-01") }];
    expect(reappearedSince(events, at("2026-01-01"))).toBe(false);
  });

  it("is true once resolved is followed by a later appearance", () => {
    const events = [
      { subject: "/a/", kind: "resolved" as const, at: at("2026-02-01") },
      { subject: "/a/", kind: "appeared" as const, at: at("2026-03-01") },
    ];
    expect(reappearedSince(events, at("2026-01-01"))).toBe(true);
  });

  it("ignores events at or before the review was written", () => {
    const events = [
      { subject: "/a/", kind: "resolved" as const, at: at("2026-01-01") },
      { subject: "/a/", kind: "appeared" as const, at: at("2026-01-02") },
    ];
    // Both events predate `since`, so this review's finding never left after all.
    expect(reappearedSince(events, at("2026-06-01"))).toBe(false);
  });
});
