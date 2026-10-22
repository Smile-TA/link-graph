/**
 * Orphan-finding reviews, persisted to `finding_reviews` — the same rows
 * `link-graph note` writes, so a judgement made in the dashboard is shared with everyone
 * and with the CLI, and survives clearing a browser. (The pack kept reviews in browser
 * storage; this is the one place the dashboard's contract differs from the pack's.)
 *
 *   GET     -> every reviewed orphan finding, each with its bucket (reviewed, or changed
 *              since review) computed against the crawl's *current* evidence
 *   PUT     -> save a judgement; `expectedReviewedAt` is the review the reader was looking
 *              at (null for none) and a mismatch is a 409, never a silent overwrite
 *   DELETE  -> remove one, with the same `expectedReviewedAt` check
 */
import {
  runNoteCommand,
  runReportCommand,
  siteBySlug,
  UsageError,
} from "@link-graph/cli";
import {
  deleteFindingReview,
  findFindingReview,
  REVIEW_STATES,
  type ReviewState,
} from "@link-graph/db";
import type { ReviewedFinding } from "@link-graph/review";
import type { APIRoute } from "astro";
import { pool } from "../../../../../db";

export const prerender = false;

interface ReviewItem {
  kind: "orphan";
  siteId: string;
  subject: string;
  state: ReviewState;
  note: string;
  reviewedBy: string;
  reviewedAt: string;
  /** `reviewed`, or `changed` when the evidence moved since the judgement. */
  bucket: "reviewed" | "changed";
}

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function item(siteId: string, finding: ReviewedFinding): ReviewItem | null {
  if (finding.review === null || finding.bucket === "new") return null;
  return {
    kind: "orphan",
    siteId,
    subject: finding.finding.subject,
    state: finding.review.state,
    note: finding.review.note,
    reviewedBy: finding.review.reviewedBy,
    reviewedAt: finding.review.reviewedAt.toISOString(),
    bucket: finding.bucket,
  };
}

function isReviewState(value: unknown): value is ReviewState {
  return (
    typeof value === "string" && (REVIEW_STATES as readonly string[]).includes(value)
  );
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The review the caller saw against the one stored now; `true` when someone else changed it. */
async function changedSince(
  siteId: string,
  subject: string,
  expected: unknown,
): Promise<boolean> {
  const site = await siteBySlug(pool, siteId);
  const current = await findFindingReview(pool, site.id, "orphan", subject);
  return (
    (current?.reviewedAt.toISOString() ?? null) !==
    (typeof expected === "string" ? expected : null)
  );
}

const CHANGED =
  "This review changed since you opened it. Close the form, reload the reviews and reopen it before saving.";

export const GET: APIRoute = async ({ params }) => {
  const { siteId } = params;
  if (siteId === undefined) return fail(400, "Missing site");
  try {
    const report = await runReportCommand(pool, siteId);
    const reviews = report.orphans.flatMap((finding) => item(siteId, finding) ?? []);
    return Response.json(reviews, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof UsageError) return fail(404, error.message);
    // A site the report refuses (no complete crawl, or two numbers for one question) has no
    // orphan findings to judge — an empty list, not a server failure.
    return Response.json([], { headers: { "cache-control": "no-store" } });
  }
};

export const PUT: APIRoute = async ({ params, request }) => {
  const { siteId } = params;
  const body = await readBody(request);
  if (siteId === undefined || body === null) return fail(400, "Invalid review request");
  const { subject, state, note, reviewedBy } = body;
  if (typeof subject !== "string" || subject === "") return fail(400, "Missing page");
  if (!isReviewState(state)) return fail(400, "Choose Intentional or Acknowledged.");
  if (
    typeof note !== "string" ||
    note.trim() === "" ||
    typeof reviewedBy !== "string" ||
    reviewedBy.trim() === ""
  ) {
    return fail(
      400,
      "A review needs a note and reviewer name. Blank spaces are not enough.",
    );
  }
  try {
    if (await changedSince(siteId, subject, body.expectedReviewedAt))
      return fail(409, CHANGED);
    await runNoteCommand(
      pool,
      {
        siteId,
        finding: "orphan",
        subject,
        state,
        note: note.trim(),
        reviewedBy: reviewedBy.trim(),
      },
      new Date(),
    );
    const saved = (await runReportCommand(pool, siteId)).orphans
      .map((finding) => item(siteId, finding))
      .find((candidate) => candidate?.subject === subject);
    return saved
      ? Response.json(saved)
      : fail(409, "The review was saved but the finding has since changed. Reload.");
  } catch (error) {
    if (error instanceof UsageError) return fail(404, error.message);
    return fail(409, error instanceof Error ? error.message : String(error));
  }
};

export const DELETE: APIRoute = async ({ params, request }) => {
  const { siteId } = params;
  const body = await readBody(request);
  if (siteId === undefined || body === null) return fail(400, "Invalid review request");
  const { subject } = body;
  if (typeof subject !== "string" || subject === "") return fail(400, "Missing page");
  try {
    if (await changedSince(siteId, subject, body.expectedReviewedAt))
      return fail(409, CHANGED);
    const site = await siteBySlug(pool, siteId);
    await deleteFindingReview(pool, site.id, "orphan", subject);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof UsageError) return fail(404, error.message);
    return fail(409, error instanceof Error ? error.message : String(error));
  }
};
