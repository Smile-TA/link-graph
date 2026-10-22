import type { Page } from './sampleData';

/*
 * Modified from the pack: reviews are persisted to the shared `finding_reviews` table through
 * `/api/link-graph/sites/:siteId/reviews`, not to browser storage. The types, `reviewBucket`
 * and `ReviewError` keep the pack's names so the components using them are unchanged. What
 * differs: a review carries its `bucket` (computed on the server against the crawl's current
 * evidence — the server's evidence digest, not a client-side comparison key), and saving
 * and removing are asynchronous.
 */
export type ReviewState = 'intentional' | 'acknowledged';
export type ReviewBucket = 'new' | 'changed' | 'reviewed';

export interface ReviewDraft {
  state: ReviewState;
  note: string;
  reviewedBy: string;
}

export interface OrphanReview extends ReviewDraft {
  kind: 'orphan';
  siteId: string;
  subject: string;
  reviewedAt: string;
  /** `reviewed`, or `changed` when the captured evidence moved since the judgement. */
  bucket: Exclude<ReviewBucket, 'new'>;
}

export type OrphanReviews = Record<string, OrphanReview>;

export class ReviewError extends Error {}

export function reviewBucket(_page: Page, review: OrphanReview | undefined): ReviewBucket {
  return review ? review.bucket : 'new';
}

function reviewsUrl(siteId: string) {
  return `/api/link-graph/sites/${encodeURIComponent(siteId)}/reviews`;
}

async function failure(response: Response, fallback: string): Promise<ReviewError> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      return new ReviewError(body.error);
    }
  } catch {
    // A body that is not JSON carries no better message than the fallback.
  }
  return new ReviewError(fallback);
}

export async function loadOrphanReviews(siteId: string): Promise<OrphanReviews> {
  const response = await fetch(reviewsUrl(siteId), { headers: { accept: 'application/json' } });
  if (!response.ok) throw await failure(response, 'Saved reviews could not be loaded.');
  const rows = await response.json() as OrphanReview[];
  return Object.fromEntries(rows.map(row => [row.subject, row]));
}

export async function saveOrphanReview(
  siteId: string,
  page: Page,
  draft: ReviewDraft,
  expectedReviewedAt: string | null,
): Promise<OrphanReview> {
  if (!draft.note.trim() || !draft.reviewedBy.trim()) {
    throw new ReviewError('A review needs a note and reviewer name. Blank spaces are not enough.');
  }
  const response = await fetch(reviewsUrl(siteId), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: page.url, ...draft, expectedReviewedAt }),
  });
  if (!response.ok) throw await failure(response, 'The review was not saved. Keep your draft and try again.');
  return await response.json() as OrphanReview;
}

export async function removeOrphanReview(
  siteId: string,
  page: Page,
  expectedReviewedAt: string | null,
): Promise<void> {
  const response = await fetch(reviewsUrl(siteId), {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: page.url, expectedReviewedAt }),
  });
  if (!response.ok) throw await failure(response, 'The review was not removed. Your saved note has not been changed.');
}
