import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadOrphanReviews, removeOrphanReview, ReviewError, reviewBucket, saveOrphanReview,
  type OrphanReview,
} from '@workspace/link-graph-ui/data/orphanReviews';
import type { Page } from '@workspace/link-graph-ui/data/sampleData';

/*
 * The data layer behind the review UI: the pack's browser-storage functions, replaced by
 * calls to the dashboard's `/api/link-graph/sites/:siteId/reviews`. Checks what is sent, what
 * is refused before anything is sent, and that the server's message reaches the reader.
 */
const page = { url: 'https://alpha.test/private/', path: '/private/', title: '/private/', statusCode: 200,
  pageClass: 'orphan', depth: null, indexable: true, inboundCount: 0, outboundCount: 0 } as Page;
const review: OrphanReview = {
  kind: 'orphan', siteId: 'alpha', subject: page.url, state: 'intentional', note: 'By design',
  reviewedBy: 'T', reviewedAt: '2026-10-22T12:00:00.000Z', bucket: 'reviewed',
};
const draft = { state: 'intentional' as const, note: ' By design ', reviewedBy: ' T ' };

function respond(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

describe('review buckets', () => {
  it('is new without a review, and otherwise whatever the server judged the evidence to be', () => {
    expect(reviewBucket(page, undefined)).toBe('new');
    expect(reviewBucket(page, review)).toBe('reviewed');
    expect(reviewBucket(page, { ...review, bucket: 'changed' })).toBe('changed');
  });
});

describe('loadOrphanReviews', () => {
  it('keys the reviews by the page URL they judge', async () => {
    respond(Response.json([review]));
    expect(await loadOrphanReviews('alpha')).toEqual({ [page.url]: review });
  });

  it('encodes the site id and surfaces the server message on failure', async () => {
    const fetchMock = respond(Response.json({ error: 'No complete crawl yet' }, { status: 409 }));
    await expect(loadOrphanReviews('a b/c')).rejects.toThrow(new ReviewError('No complete crawl yet'));
    expect(fetchMock).toHaveBeenCalledWith('/api/link-graph/sites/a%20b%2Fc/reviews', expect.anything());
  });

  it('falls back to a plain message when the failure body is not JSON', async () => {
    respond(new Response('<html>', { status: 502 }));
    await expect(loadOrphanReviews('alpha')).rejects.toThrow('Saved reviews could not be loaded.');
  });
});

describe('saveOrphanReview', () => {
  it('sends the page URL, the trimmed-by-the-server draft and the review the reader saw', async () => {
    const fetchMock = respond(Response.json(review));
    await saveOrphanReview('alpha', page, draft, '2026-10-21T00:00:00.000Z');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/link-graph/sites/alpha/reviews');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      subject: page.url, ...draft, expectedReviewedAt: '2026-10-21T00:00:00.000Z',
    });
  });

  it('refuses a blank note or reviewer without calling the server', async () => {
    const fetchMock = respond(Response.json(review));
    await expect(saveOrphanReview('alpha', page, { ...draft, note: '   ' }, null)).rejects.toBeInstanceOf(ReviewError);
    await expect(saveOrphanReview('alpha', page, { ...draft, reviewedBy: '' }, null)).rejects.toBeInstanceOf(ReviewError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the optimistic-lock conflict', async () => {
    respond(Response.json({ error: 'This review changed since you opened it.' }, { status: 409 }));
    await expect(saveOrphanReview('alpha', page, draft, null)).rejects.toThrow('This review changed since you opened it.');
  });
});

describe('removeOrphanReview', () => {
  it('sends a DELETE carrying the review the reader saw', async () => {
    const fetchMock = respond(new Response(null, { status: 204 }));
    await removeOrphanReview('alpha', page, review.reviewedAt);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(String(init.body))).toEqual({ subject: page.url, expectedReviewedAt: review.reviewedAt });
  });

  it('reports a refused removal', async () => {
    respond(Response.json({ error: 'This review changed since you opened it.' }, { status: 409 }));
    await expect(removeOrphanReview('alpha', page, null)).rejects.toThrow(ReviewError);
  });
});
