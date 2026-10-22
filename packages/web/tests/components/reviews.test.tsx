import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrphanReviews } from '@workspace/link-graph-ui/components/orphan-reviews';
import type { OrphanReview } from '@workspace/link-graph-ui/data/orphanReviews';
import { useOrphanReviews } from '@workspace/link-graph-ui/hooks/use-orphan-reviews';
import { renderUI } from './helpers';

/*
 * Ported from the pack's review tests, rewritten for the one place this app differs from the
 * pack: reviews live in the shared `finding_reviews` table behind
 * `/api/link-graph/sites/:siteId/reviews`, not in browser storage. The tests drive the real
 * components against an in-memory fake of that endpoint, including its optimistic-lock 409.
 */
const id = encodeURIComponent('/private/');
const subject = 'https://alpha.test/private/';

let stored: Map<string, OrphanReview>;
let requests: { method: string; body: unknown }[];
let failNextWrite: Response | null;
let clock: number;

function fakeApi() {
  stored = new Map();
  requests = [];
  failNextWrite = null;
  clock = Date.parse('2026-10-22T12:00:00.000Z');
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ method, body });
    if (method === 'GET') return Response.json([...stored.values()]);
    if (failNextWrite) { const response = failNextWrite; failNextWrite = null; return response; }
    const subjectKey = String(body?.subject);
    const current = stored.get(subjectKey)?.reviewedAt ?? null;
    if (current !== (body?.expectedReviewedAt ?? null)) {
      return Response.json({ error: 'This review changed since you opened it.' }, { status: 409 });
    }
    if (method === 'DELETE') { stored.delete(subjectKey); return new Response(null, { status: 204 }); }
    const saved: OrphanReview = {
      kind: 'orphan', siteId: 'alpha', subject: subjectKey, state: body?.state as OrphanReview['state'],
      note: String(body?.note), reviewedBy: String(body?.reviewedBy),
      reviewedAt: new Date(clock += 1000).toISOString(), bucket: 'reviewed',
    };
    stored.set(subjectKey, saved);
    return Response.json(saved);
  }));
}

beforeEach(fakeApi);
afterEach(() => vi.unstubAllGlobals());

async function fillAndSave(user: ReturnType<typeof userEvent.setup>, note: string, by = 'UI tester') {
  await user.clear(screen.getByLabelText('Review note for /private/'));
  await user.type(screen.getByLabelText('Review note for /private/'), note);
  await user.clear(screen.getByLabelText('Reviewer name for /private/'));
  await user.type(screen.getByLabelText('Reviewer name for /private/'), by);
  await user.click(screen.getByTestId(`button-save-review-${id}`));
}

describe('Orphan review forms, persisted to the database', () => {
  it('validates, saves, prefills edits, cancels edits, and confirms deletion', async () => {
    const user = userEvent.setup();
    renderUI(<OrphanReviews />);
    await user.click(screen.getByTestId(`button-review-orphan-${id}`));
    await fillAndSave(user, 'By design');
    await user.click(screen.getByTestId('filter-orphan-reviewed'));
    expect(await screen.findByText('By design')).toBeInTheDocument();
    expect(stored.get(subject)).toMatchObject({ note: 'By design', reviewedBy: 'UI tester', state: 'intentional' });

    await user.click(screen.getByTestId(`button-edit-review-${id}`));
    expect(screen.getByLabelText('Review note for /private/')).toHaveValue('By design');
    await user.clear(screen.getByLabelText('Review note for /private/'));
    await user.type(screen.getByLabelText('Review note for /private/'), '   ');
    await user.click(screen.getByTestId(`button-save-review-${id}`));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(stored.get(subject)?.note).toBe('By design'); // a blank note never reaches the server
    await user.click(screen.getByTestId(`button-cancel-review-${id}`));
    expect(screen.getByText('By design')).toBeInTheDocument();

    await user.click(screen.getByTestId(`button-remove-review-${id}`));
    await user.click(screen.getByTestId(`button-cancel-remove-review-${id}`));
    expect(screen.getByText('By design')).toBeInTheDocument();
    await user.click(screen.getByTestId(`button-remove-review-${id}`));
    await user.click(screen.getByTestId(`button-confirm-remove-review-${id}`));
    await waitFor(() => expect(screen.queryByText('By design')).not.toBeInTheDocument());
    expect(stored.has(subject)).toBe(false);
    await user.click(screen.getByTestId('filter-orphan-all'));
    expect(screen.getByTestId(`button-review-orphan-${id}`)).toBeInTheDocument();
  });

  it('shows what is already in the database, including a changed-since-review bucket', async () => {
    stored.set(subject, {
      kind: 'orphan', siteId: 'alpha', subject, state: 'acknowledged', note: 'Looked at it',
      reviewedBy: 'Someone else', reviewedAt: '2026-10-20T09:00:00.000Z', bucket: 'changed',
    });
    renderUI(<OrphanReviews />);
    await waitFor(() => expect(screen.getByTestId('count-orphan-changed')).toHaveTextContent('1'));
    // The list shows new findings first, so look at the bucket the review is in.
    await userEvent.click(screen.getByTestId('filter-orphan-changed'));
    expect(await screen.findByText('Looked at it')).toBeInTheDocument();
    expect(screen.getByText(/Captured link evidence has changed since this judgement/)).toBeInTheDocument();
  });

  it('refuses to overwrite a review someone else changed, and keeps the draft', async () => {
    const user = userEvent.setup();
    renderUI(<OrphanReviews />);
    await user.click(screen.getByTestId(`button-review-orphan-${id}`));
    // Another person saves first, after this form opened with "no review yet".
    stored.set(subject, {
      kind: 'orphan', siteId: 'alpha', subject, state: 'intentional', note: 'Theirs',
      reviewedBy: 'Them', reviewedAt: '2026-10-22T13:00:00.000Z', bucket: 'reviewed',
    });
    await fillAndSave(user, 'Mine');
    expect(await screen.findByText(/changed since you opened it/)).toBeInTheDocument();
    expect(stored.get(subject)?.note).toBe('Theirs');
    expect(screen.getByLabelText('Review note for /private/')).toHaveValue('Mine');
  });

  it('preserves the draft when the save fails', async () => {
    const user = userEvent.setup();
    renderUI(<OrphanReviews />);
    await user.click(screen.getByTestId(`button-review-orphan-${id}`));
    failNextWrite = new Response('boom', { status: 500 });
    await fillAndSave(user, 'Keep this draft', 'Tester');
    expect(await screen.findByText(/was not saved/)).toBeInTheDocument();
    expect(screen.getByLabelText('Review note for /private/')).toHaveValue('Keep this draft');
    expect(stored.size).toBe(0);
  });

  it('reports a failed load with a retry instead of hiding the problem', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('down', { status: 503 }));
    const user = userEvent.setup();
    renderUI(<OrphanReviews />);
    const retry = await screen.findByTestId('button-retry-orphan-reviews');
    await user.click(retry);
    await waitFor(() => expect(screen.queryByTestId('button-retry-orphan-reviews')).not.toBeInTheDocument());
  });

  it('searches the complete orphan set beyond the first 25 rows', async () => {
    renderUI(<OrphanReviews />);
    await userEvent.type(screen.getByRole('searchbox'), 'orphan-27');
    expect(screen.getByTestId(`button-review-orphan-${encodeURIComponent('/orphan-27/')}`)).toBeInTheDocument();
  });
});

describe('Review freshness', () => {
  const row = (note: string): OrphanReview => ({
    kind: 'orphan', siteId: 'alpha', subject, state: 'intentional', note,
    reviewedBy: 'Fixture reviewer', reviewedAt: '2026-10-22T12:00:00.000Z', bucket: 'reviewed',
  });
  const restore = () => act(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });

  it('rereads changed and removed reviews on a persisted pageshow only', async () => {
    stored.set(subject, row('Original'));
    const { result } = renderHook(() => useOrphanReviews('alpha'));
    await waitFor(() => expect(result.current.reviews[subject]?.note).toBe('Original'));
    stored.set(subject, row('Edited elsewhere'));
    act(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })); });
    expect(result.current.reviews[subject]?.note).toBe('Original');
    restore();
    await waitFor(() => expect(result.current.reviews[subject]?.note).toBe('Edited elsewhere'));
    stored.clear();
    restore();
    await waitFor(() => expect(result.current.reviews).toEqual({}));
    expect(requests.every(request => request.method === 'GET')).toBe(true); // reading never writes
  });

  it('keeps loaded reviews and reports an error when a reload fails, then recovers', async () => {
    stored.set(subject, row('Keep loaded note'));
    const { result } = renderHook(() => useOrphanReviews('alpha'));
    await waitFor(() => expect(result.current.reviews[subject]).toBeDefined());
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('down', { status: 503 }));
    restore();
    await waitFor(() => expect(result.current.error).toMatch(/could not be loaded/));
    expect(result.current.reviews[subject]?.note).toBe('Keep loaded note');
    stored.set(subject, row('Recovered'));
    restore();
    await waitFor(() => expect(result.current.reviews[subject]?.note).toBe('Recovered'));
    expect(result.current.error).toBeNull();
  });

  it('removes the lifecycle listener when the hook unmounts', async () => {
    const { unmount } = renderHook(() => useOrphanReviews('alpha'));
    await waitFor(() => expect(requests).toHaveLength(1));
    unmount();
    restore();
    expect(requests).toHaveLength(1);
  });
});
