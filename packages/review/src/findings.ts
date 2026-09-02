/**
 * A measured row from the database as a finding with its evidence.
 *
 * Two functions, and they exist so that "what a review of this kind is about" has one
 * home: the subject a review keys on (PRD §7.1 rule 2) and the evidence its digest is
 * taken over (rule 5) are decided here, for both the read path that buckets findings and
 * the write path that records a judgement of one. Two copies would drift into a report
 * where reviewing a finding does not silence it.
 */
import type { BrokenLinkFinding, OrphanFinding } from "@link-graph/db";
import type { Finding } from "./bucket.js";
import type { BrokenLinkEvidence, OrphanEvidence } from "./evidence.js";

export function orphanFinding(page: OrphanFinding): Finding<OrphanEvidence> {
  return {
    subject: page.urlNormalized,
    evidence: {
      kind: "orphan",
      class: page.class,
      postType: page.postType,
      statusCode: page.statusCode,
    },
  };
}

/** The subject is the link's **target**, never the pages linking to it (rule 2). */
export function brokenLinkFinding(link: BrokenLinkFinding): Finding<BrokenLinkEvidence> {
  return {
    subject: link.urlNormalized,
    evidence: {
      kind: "broken_internal_link",
      statusCode: link.statusCode,
      blastRadius: link.blastRadius,
    },
  };
}
