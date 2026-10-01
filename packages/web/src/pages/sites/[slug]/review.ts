/**
 * `POST /sites/:slug/review` — the web form's write path for docs/notes.md item 7
 * ("accept that it is ok for this page to be an orphan"). One call into
 * `runNoteCommand`, the same function `link-graph note` runs, so a review written here
 * and one written from the CLI are indistinguishable rows.
 */
import { runNoteCommand, UsageError } from "@link-graph/cli";
import { FINDING_KINDS, REVIEW_STATES, type FindingKind, type ReviewState } from "@link-graph/db";
import type { APIRoute } from "astro";
import { pool } from "../../../db";

export const prerender = false;

function isFindingKind(value: unknown): value is FindingKind {
  return typeof value === "string" && (FINDING_KINDS as readonly string[]).includes(value);
}

function isReviewState(value: unknown): value is ReviewState {
  return typeof value === "string" && (REVIEW_STATES as readonly string[]).includes(value);
}

export const POST: APIRoute = async ({ params, request }) => {
  const { slug } = params;
  if (slug === undefined) return new Response("missing site slug", { status: 400 });

  const form = await request.formData();
  const finding = form.get("kind");
  const state = form.get("state");
  const subject = form.get("subject");
  const note = form.get("note");
  const reviewedBy = form.get("reviewedBy");
  const returnTo = form.get("returnTo");

  if (!isFindingKind(finding) || !isReviewState(state)) {
    return new Response("invalid kind or state", { status: 400 });
  }
  if (typeof subject !== "string" || subject === "") {
    return new Response("missing subject", { status: 400 });
  }
  if (typeof note !== "string" || note.trim() === "") {
    return new Response("a review needs a note", { status: 400 });
  }
  if (typeof reviewedBy !== "string" || reviewedBy.trim() === "") {
    return new Response("a review needs who wrote it", { status: 400 });
  }

  try {
    await runNoteCommand(
      pool,
      { siteId: slug, finding, subject, state, note: note.trim(), reviewedBy: reviewedBy.trim() },
      new Date(),
    );
  } catch (error) {
    const status = error instanceof UsageError ? 404 : 409;
    const message = error instanceof Error ? error.message : String(error);
    return new Response(message, { status, headers: { "content-type": "text/plain" } });
  }

  const redirectTo = typeof returnTo === "string" && returnTo !== "" ? returnTo : `/sites/${slug}/`;
  return new Response(null, { status: 303, headers: { Location: redirectTo } });
};
