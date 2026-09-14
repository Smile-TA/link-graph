import { describe, expect, it } from "vitest";
import type { FindingReviewRow } from "@link-graph/db";
import { reappearedSubjects } from "./reappear.js";

const at = (isoDate: string) => new Date(isoDate);

function review(subject: string, reviewedAt: Date): FindingReviewRow {
  return {
    id: 1,
    siteId: 1,
    kind: "orphan",
    subject,
    state: "intentional",
    note: "n/a",
    evidenceDigest: "digest",
    reviewedBy: "smile",
    reviewedAt,
  };
}

describe("reappearedSubjects", () => {
  it("is empty with no reviews", () => {
    expect(reappearedSubjects(new Map(), [])).toEqual(new Set());
  });

  it("flags a reviewed subject that resolved and later reappeared", () => {
    const reviews = new Map([["/a/", review("/a/", at("2026-01-01"))]]);
    const events = [
      { subject: "/a/", kind: "resolved" as const, at: at("2026-02-01") },
      { subject: "/a/", kind: "appeared" as const, at: at("2026-03-01") },
    ];
    expect(reappearedSubjects(reviews, events)).toEqual(new Set(["/a/"]));
  });

  it("leaves an untouched review alone", () => {
    const reviews = new Map([["/a/", review("/a/", at("2026-01-01"))]]);
    expect(reappearedSubjects(reviews, [])).toEqual(new Set());
  });

  it("never checks a subject with no review, even if its history reappeared", () => {
    const reviews = new Map<string, FindingReviewRow>();
    const events = [
      { subject: "/b/", kind: "resolved" as const, at: at("2026-02-01") },
      { subject: "/b/", kind: "appeared" as const, at: at("2026-03-01") },
    ];
    expect(reappearedSubjects(reviews, events)).toEqual(new Set());
  });
});
