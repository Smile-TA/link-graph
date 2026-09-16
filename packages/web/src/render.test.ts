import { describe, expect, it } from "vitest";
import type { BrokenLinkEvidence, FindingEvidence, OrphanEvidence, ReviewedFinding } from "@link-graph/review";
import { brokenEvidence, orphanEvidence } from "./render.js";

function finding(evidence: FindingEvidence): ReviewedFinding {
  return { finding: { subject: "x", evidence }, review: null, bucket: "new" };
}

describe("orphanEvidence", () => {
  it("prints the status code", () => {
    const evidence: OrphanEvidence = { kind: "orphan", class: "orphan", postType: null, statusCode: 200 };
    expect(orphanEvidence(finding(evidence))).toBe("status 200");
  });

  it("says never fetched rather than printing null", () => {
    const evidence: OrphanEvidence = { kind: "orphan", class: "orphan", postType: null, statusCode: null };
    expect(orphanEvidence(finding(evidence))).toBe("status never fetched");
  });
});

describe("brokenEvidence", () => {
  it("prints status and blast radius", () => {
    const evidence: BrokenLinkEvidence = { kind: "broken_internal_link", statusCode: 404, blastRadius: 3 };
    expect(brokenEvidence(finding(evidence))).toBe("status 404, linked from 3 page(s)");
  });
});
