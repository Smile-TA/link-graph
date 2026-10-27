import { useCallback, useEffect, useState } from 'react';
import type { Page } from '.././data/sampleData';
import {
  loadOrphanReviews, removeOrphanReview, ReviewError, saveOrphanReview,
  type OrphanReviews, type ReviewDraft,
} from '.././data/orphanReviews';

/*
 * Modified from the pack: reads and writes the shared `finding_reviews` table through the
 * dashboard's API instead of browser storage. `saveReview` and `removeReview` return a
 * promise of the same boolean the pack's returned synchronously.
 */
interface Snapshot {
  reviews: OrphanReviews;
  error: string | null;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof ReviewError ? error.message : fallback;
}

/** Mount with a site key: review drafts never cross site boundaries. */
export function useOrphanReviews(siteId: string) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ reviews: {}, error: null });

  const reload = useCallback(() => {
    loadOrphanReviews(siteId).then(
      reviews => setSnapshot({ reviews, error: null }),
      error => setSnapshot(previous => ({
        // Do not hide already-loaded notes when a reload fails.
        ...previous,
        error: errorMessage(error, 'Reviews could not be loaded. Check the connection and retry.'),
      })),
    );
  }, [siteId]);

  useEffect(() => {
    reload();
    // A page restored from the back/forward cache may be stale: another person may have
    // reviewed something since. Re-read on a genuine history restore.
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) reload();
    };
    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, [reload]);

  return {
    ...snapshot,
    reload,
    saveReview: async (page: Page, draft: ReviewDraft, expectedReviewedAt: string | null) => {
      try {
        const saved = await saveOrphanReview(siteId, page, draft, expectedReviewedAt);
        setSnapshot(previous => ({ reviews: { ...previous.reviews, [saved.subject]: saved }, error: null }));
        return true;
      } catch (error) {
        setSnapshot(previous => ({ ...previous, error: errorMessage(error, 'The review was not saved. Keep your draft and try again.') }));
        return false;
      }
    },
    removeReview: async (page: Page, expectedReviewedAt: string | null) => {
      try {
        await removeOrphanReview(siteId, page, expectedReviewedAt);
        setSnapshot(previous => {
          const reviews = { ...previous.reviews };
          delete reviews[page.url];
          return { reviews, error: null };
        });
        return true;
      } catch (error) {
        setSnapshot(previous => ({ ...previous, error: errorMessage(error, 'The review was not removed. Your saved note has not been changed.') }));
        return false;
      }
    },
  };
}
