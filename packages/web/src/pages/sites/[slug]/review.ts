/**
 * `POST /sites/:slug/review` — the web form's write path for docs/notes.md item 7
 * ("accept that it is ok for this page to be an orphan"). Writing a review calls
 * `runNoteCommand`, the same function `link-graph note` runs, so a review written here
 * and one written from the CLI are indistinguishable rows. `intent=delete` instead
 * clears a review entirely (not the same as re-judging it with a new note) — for when
 * the judgement itself was wrong, not just its wording.
 */
import { runNoteCommand, siteBySlug, UsageError } from "@link-graph/cli";
import {
  deleteFindingReview,
  FINDING_KINDS,
  REVIEW_STATES,
  type FindingKind,
  type ReviewState,
} from "@link-graph/db";
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
  const subject = form.get("subject");
  const returnTo = form.get("returnTo");
  const redirectTo = typeof returnTo === "string" && returnTo !== "" ? returnTo : `/sites/${slug}/`;

  if (!isFindingKind(finding)) {
    return new Response("invalid kind", { status: 400 });
  }
  if (typeof subject !== "string" || subject === "") {
    return new Response("missing subject", { status: 400 });
  }

  if (form.get("intent") === "delete") {
    try {
      const site = await siteBySlug(pool, slug);
      await deleteFindingReview(pool, site.id, finding, subject);
    } catch (error) {
      const status = error instanceof UsageError ? 404 : 409;
      const message = error instanceof Error ? error.message : String(error);
      return new Response(message, { status, headers: { "content-type": "text/plain" } });
    }
    return new Response(null, { status: 303, headers: { Location: redirectTo } });
  }

  const state = form.get("state");
  const note = form.get("note");
  const reviewedBy = form.get("reviewedBy");

  if (!isReviewState(state)) {
    return new Response("invalid state", { status: 400 });
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

  return new Response(null, { status: 303, headers: { Location: redirectTo } });
};
