import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import { reviewBucket, type OrphanReview, type ReviewDraft } from '.././data/orphanReviews';
import type { Page } from '.././data/sampleData';
import { useOrphanReviews } from '.././hooks/use-orphan-reviews';
import { useFixture } from './fixture-context';
import './orphan-reviews.css';

type Bucket = 'all' | 'new' | 'changed' | 'reviewed';

const bucketLabels: Record<Bucket, string> = {
  all: 'All',
  new: 'New',
  changed: 'Changed since review',
  reviewed: 'Reviewed',
};

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function reviewStateLabel(state: OrphanReview['state']) {
  return state === 'intentional' ? 'Intentional — unlinked by design' : 'Acknowledged — needs attention';
}

export function OrphanReviews() {
  const { site, pages, sitePath, source } = useFixture();
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(25);
  const { reviews, error, reload, saveReview, removeReview } = useOrphanReviews(site.siteId);
  const [bucket, setBucket] = useState<Bucket>('all');
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReviewDraft>({ state: 'intentional', note: '', reviewedBy: '' });
  const [expectedReviewedAt, setExpectedReviewedAt] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [confirmRemovalUrl, setConfirmRemovalUrl] = useState<string | null>(null);
  const [removalReviewedAt, setRemovalReviewedAt] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const orphans = useMemo(() => pages.filter((page) => source === 'database' ? page.pageClass === 'orphan' : page.inboundCount === 0), [pages, source]);
  const counts = useMemo(() => {
    const result = { new: 0, changed: 0, reviewed: 0 };
    for (const page of orphans) result[reviewBucket(page, reviews[page.url])] += 1;
    return result;
  }, [orphans, reviews]);
  const bucketOrder = { new: 0, changed: 1, reviewed: 2 };
  const visiblePages = orphans
    .filter((page) => (bucket === 'all' || reviewBucket(page, reviews[page.url]) === bucket) && `${page.path} ${page.url}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => bucketOrder[reviewBucket(a, reviews[a.url])] - bucketOrder[reviewBucket(b, reviews[b.url])]);

  function openForm(page: Page) {
    const existing = reviews[page.url];
    setEditingUrl(page.url);
    setExpectedReviewedAt(existing?.reviewedAt ?? null);
    setDraft(existing
      ? { state: existing.state, note: existing.note, reviewedBy: existing.reviewedBy }
      : { state: 'intentional', note: '', reviewedBy: '' });
    setFormError('');
    setMessage('');
    setConfirmRemovalUrl(null);
  }

  function cancelForm() {
    setEditingUrl(null);
    setFormError('');
  }

  async function submitReview(event: FormEvent<HTMLFormElement>, page: Page) {
    event.preventDefault();
    const cleaned = {
      ...draft,
      note: draft.note.trim(),
      reviewedBy: draft.reviewedBy.trim(),
    };
    if (!cleaned.note || !cleaned.reviewedBy) {
      setFormError('Add a note and reviewer name. Whitespace alone is not accepted.');
      return;
    }
    const wasEditing = expectedReviewedAt !== null;
    const saved = await saveReview(page, cleaned, expectedReviewedAt);
    if (!saved) {
      setFormError('This review could not be saved. It may have changed elsewhere; reload reviews and try again.');
      return;
    }
    setEditingUrl(null);
    setFormError('');
    setMessage(`${wasEditing ? 'Review updated' : 'Review saved'} for ${page.path}.`);
  }

  async function confirmRemove(page: Page) {
    const existing = reviews[page.url];
    if (!existing) return;
    const removed = await removeReview(page, removalReviewedAt);
    if (!removed) {
      setMessage(`The review for ${page.path} was not removed. It may have changed elsewhere; reload reviews and try again.`);
      setConfirmRemovalUrl(null);
      return;
    }
    setConfirmRemovalUrl(null);
    setEditingUrl(null);
    setMessage(`Review removed for ${page.path}. The page finding remains listed as New.`);
  }

  return (
    <section className="orphan-review panel" aria-labelledby="orphan-review-title">
      <header className="orphan-review__header">
        <div>
          <div className="section-title" style={{ margin: 0 }}>
            <h2 id="orphan-review-title">Pages without inbound links</h2>
          </div>
          <p className="orphan-review__lede">{source === 'database' ? 'Pages classified as orphan by the imported crawl. Partial and unsampled evidence must not be treated as a complete site audit.' : 'No captured internal link points to these URLs.'} Review the evidence; a judgement does not change the measured link graph.</p>
        </div>
        <span className="finding-count" data-testid="text-orphan-total">{orphans.length} {orphans.length === 1 ? 'page' : 'pages'}</span>
      </header>

      <div className="orphan-review__notice">
        <strong>Review notes are saved to the shared database.</strong>
        <span>Everyone sees them, and the CLI reads the same records. A note is judged against the crawl's current evidence: if it changes, the finding returns as Changed since review. Reviews never remove a finding or change its inbound count.</span>
      </div>

      <div className="orphan-review__counts" aria-label="Orphan review counts">
        {(['new', 'changed', 'reviewed'] as const).map((key) => (
          <div className={`orphan-review__count orphan-review__count--${key}`} key={key}>
            <span>{key === 'changed' ? 'Changed since review' : key === 'reviewed' ? 'Reviewed' : 'New'}</span>
            <strong data-testid={`count-orphan-${key}`}>{counts[key]}</strong>
          </div>
        ))}
      </div>

      <div className="orphan-review__toolbar">
        <div className="orphan-review__filters" role="group" aria-label="Filter orphan findings">
          {(['all', 'new', 'changed', 'reviewed'] as Bucket[]).map((key) => (
            <button
              type="button"
              key={key}
              className={`orphan-review__filter${bucket === key ? ' is-active' : ''}`}
              aria-pressed={bucket === key}
              onClick={() => { setBucket(key); setLimit(25); }}
              data-testid={`filter-orphan-${key}`}
            >
              {bucketLabels[key]} <span>{key === 'all' ? orphans.length : counts[key]}</span>
            </button>
          ))}
        </div>
        <span className="orphan-review__shown" aria-live="polite">Showing {Math.min(limit, visiblePages.length)} of {visiblePages.length} matching · {orphans.length} total</span>
      </div>
      {orphans.length > 25 && <label className="page-search" style={{ margin: '12px 20px' }}>Search orphan paths<input type="search" value={search} onChange={event => { setSearch(event.target.value); setLimit(25); }} /></label>}
      {source === 'database' && site.orphanCount === null && <p className="panel-pad explorer-note">The overall orphan total is unknown ({site.orphanUnknownReason?.replaceAll('_', ' ')}). The list below shows only recorded orphan classifications, not a complete site-wide count.</p>}

      {error && (
        <div className="orphan-review__error" role="alert">
          <span>{error}</span>
          <button type="button" className="orphan-review__text-button" onClick={reload} data-testid="button-retry-orphan-reviews">Retry loading reviews</button>
        </div>
      )}
      <div className="orphan-review__message" aria-live="polite" role="status">{message}</div>

      {orphans.length === 0 ? (
        <div className="orphan-review__empty">
          <span className="orphan-review__empty-mark" aria-hidden="true">0</span>
          <div><h3>No orphan pages in this capture</h3><p>Every included page has at least one inbound internal link, or page data has not been loaded yet.</p></div>
        </div>
      ) : visiblePages.length === 0 ? (
        <div className="orphan-review__empty orphan-review__empty--filtered">
          <div><h3>No {bucketLabels[bucket].toLowerCase()} findings</h3><p>All {orphans.length} orphan {orphans.length === 1 ? 'finding is' : 'findings are'} still included in the measured list. Choose another filter to inspect them.</p></div>
        </div>
      ) : (
        <div className="orphan-review__list">
          <div className="orphan-review__column-head" aria-hidden="true">
            <span>Page and review</span><span>Depth</span><span>Inbound</span>
          </div>
          {visiblePages.slice(0, limit).map((page) => {
            const review = reviews[page.url];
            const status = reviewBucket(page, review);
            const isEditing = editingUrl === page.url;
            const confirming = confirmRemovalUrl === page.url;
            return (
              <article className="orphan-review__row" key={page.url} data-testid={`row-orphan-${encodeURIComponent(page.path)}`}>
                <div className="orphan-review__main">
                  <div className="orphan-review__page-line">
                    <div className="orphan-review__page">
                      <Link className="finding-url" href={`${sitePath}/ego?path=${encodeURIComponent(page.path)}`} data-testid={`text-page-url-${encodeURIComponent(page.path)}`}>{page.path}</Link>
                      <div className="finding-title">{page.title || page.url}</div>
                      <div className="orphan-review__evidence" data-testid={`evidence-orphan-${encodeURIComponent(page.path)}`}>
                        {page.pageClass} · {page.statusCode || 'HTTP unverified'} · {page.indexable ? 'Indexable' : 'Not indexable'} · {page.outboundCount} links to captured pages · {page.url}
                      </div>
                      <Link className="network-action compact" href={`${sitePath}/ego?path=${encodeURIComponent(page.path)}`} data-testid={`link-network-${encodeURIComponent(page.path)}`}>View page network</Link>
                    </div>
                    <span className={`orphan-review__badge orphan-review__badge--${status}`}>
                      {status === 'new' ? 'New' : status === 'changed' ? 'Changed since review' : 'Reviewed'}
                    </span>
                  </div>
                  {status === 'changed' && review && (
                    <p className="orphan-review__changed-note">Captured link evidence has changed since this judgement. Revisit the review before relying on it.</p>
                  )}
                  {review && !isEditing && (
                    <div className={`orphan-review__record${status === 'changed' ? ' is-changed' : ''}`} data-testid={`review-record-${encodeURIComponent(page.path)}`}>
                      <div className="orphan-review__record-head">
                        <span className={`orphan-review__decision orphan-review__decision--${review.state}`}>{reviewStateLabel(review.state)}</span>
                        <span className="orphan-review__record-meta">By {review.reviewedBy} · {formatTimestamp(review.reviewedAt)}</span>
                      </div>
                      <p className="orphan-review__note">{review.note}</p>
                      {confirming ? (
                        <div className="orphan-review__confirm" role="group" aria-label={`Confirm removal of review for ${page.path}`}>
                          <span>Remove this judgement? The finding will remain and return to New.</span>
                          <button type="button" className="orphan-review__button orphan-review__button--danger" onClick={() => confirmRemove(page)} data-testid={`button-confirm-remove-review-${encodeURIComponent(page.path)}`}>Remove review</button>
                          <button type="button" className="orphan-review__text-button" onClick={() => setConfirmRemovalUrl(null)} data-testid={`button-cancel-remove-review-${encodeURIComponent(page.path)}`}>Cancel</button>
                        </div>
                      ) : (
                        <div className="orphan-review__actions">
                          <button type="button" className="orphan-review__text-button" onClick={() => openForm(page)} data-testid={`button-edit-review-${encodeURIComponent(page.path)}`}>Edit review</button>
                          <button type="button" className="orphan-review__text-button orphan-review__text-button--danger" onClick={() => { setConfirmRemovalUrl(page.url); setRemovalReviewedAt(review.reviewedAt); }} data-testid={`button-remove-review-${encodeURIComponent(page.path)}`}>Remove review</button>
                        </div>
                      )}
                    </div>
                  )}
                  {!review && !isEditing && (
                    <button type="button" className="orphan-review__button" onClick={() => openForm(page)} data-testid={`button-review-orphan-${encodeURIComponent(page.path)}`}>Review finding</button>
                  )}
                  {isEditing && (
                    <form className="orphan-review__form" onSubmit={(event) => submitReview(event, page)} noValidate>
                      <div className="orphan-review__form-heading">
                        <h3>{expectedReviewedAt ? 'Edit review' : 'Record a judgement'}</h3>
                        <span>Required for this page only</span>
                      </div>
                      <label className="orphan-review__field">
                        <span>Judgement <b aria-hidden="true">*</b></span>
                        <select
                          value={draft.state}
                          onChange={(event) => setDraft({ ...draft, state: event.target.value as ReviewDraft['state'] })}
                          required
                          aria-label={`Judgement for ${page.path}`}
                          data-testid={`select-review-state-${encodeURIComponent(page.path)}`}
                        >
                          <option value="intentional">Intentional — unlinked by design</option>
                          <option value="acknowledged">Acknowledged — needs attention</option>
                        </select>
                      </label>
                      <label className="orphan-review__field">
                        <span>Review note <b aria-hidden="true">*</b></span>
                        <textarea
                          value={draft.note}
                          onChange={(event) => setDraft({ ...draft, note: event.target.value })}
                          required
                          rows={3}
                          placeholder="Record why this page is unlinked or what follow-up is needed."
                          aria-label={`Review note for ${page.path}`}
                          data-testid={`textarea-review-note-${encodeURIComponent(page.path)}`}
                        />
                      </label>
                      <label className="orphan-review__field">
                        <span>Reviewer name <b aria-hidden="true">*</b></span>
                        <input
                          value={draft.reviewedBy}
                          onChange={(event) => setDraft({ ...draft, reviewedBy: event.target.value })}
                          required
                          autoComplete="name"
                          placeholder="Name"
                          aria-label={`Reviewer name for ${page.path}`}
                          data-testid={`input-reviewer-${encodeURIComponent(page.path)}`}
                        />
                      </label>
                      <p className="orphan-review__choice-help">
                        <strong>Intentional</strong> means unlinked by design. <strong>Acknowledged</strong> records that the page still needs attention; neither changes measured evidence.
                      </p>
                      {formError && <p className="orphan-review__form-error" role="alert">{formError}</p>}
                      <div className="orphan-review__form-actions">
                        <button type="submit" className="orphan-review__button orphan-review__button--primary" data-testid={`button-save-review-${encodeURIComponent(page.path)}`}>Save review</button>
                        <button type="button" className="orphan-review__text-button" onClick={cancelForm} data-testid={`button-cancel-review-${encodeURIComponent(page.path)}`}>Cancel</button>
                      </div>
                    </form>
                  )}
                </div>
                <span className="orphan-review__depth">{page.depth === null ? 'No path' : page.depth}</span>
                <div className="orphan-review__inbound"><strong>{page.inboundCount}</strong><span>links in</span></div>
              </article>
            );
          })}
        </div>
      )}
      {visiblePages.length > limit && <button type="button" className="network-action load-pages" onClick={() => setLimit(limit + 25)}>Show 25 more orphan pages ({visiblePages.length - limit} remaining)</button>}
    </section>
  );
}
