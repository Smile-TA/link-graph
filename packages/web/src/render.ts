import type { ReviewedFinding } from "@link-graph/review";

export function orphanEvidence(finding: ReviewedFinding): string {
  const evidence = finding.finding.evidence;
  if (evidence.kind !== "orphan") throw new Error(`expected orphan evidence, got ${evidence.kind}`);
  return `status ${evidence.statusCode ?? "never fetched"}`;
}

export function brokenEvidence(finding: ReviewedFinding): string {
  const evidence = finding.finding.evidence;
  if (evidence.kind !== "broken_internal_link") {
    throw new Error(`expected broken-link evidence, got ${evidence.kind}`);
  }
  return `status ${evidence.statusCode}, linked from ${evidence.blastRadius} page(s)`;
}
