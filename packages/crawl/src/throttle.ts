/**
 * Throttling: recognising a block, and reading how long it lasts.
 *
 * Measured on whyaim.com 2026-08-18 (PRD §5.1): Wordfence answers **503 with
 * `retry-after: 3600`** — a one-hour, per-IP, per-host ban, and short bursts pass at any
 * rate, so it is a rate-over-window limit rather than a burst limit. That is the number
 * every rule here exists for. A crawler that treated the block as a transient error and
 * retried would spend the hour re-earning it, and one that recorded the 503 as the
 * page's status code would file a live page as permanently broken.
 */

/**
 * Whether this status means "the host is refusing traffic from us", as distinct from
 * "this page failed". The difference decides whether to stop the whole host or record a
 * row and carry on, so it is deliberately a short, closed list.
 *
 * 503 is the measured one. 429 is included because it is the code RFC 6585 defines for
 * exactly this condition and carries the same `retry-after`; the alternative is writing
 * a `pages` row whose status code describes our request rate rather than the page.
 * Nothing on this estate has been observed returning it.
 */
export function isThrottled(status: number): boolean {
  return status === 503 || status === 429;
}

/**
 * `retry-after` in seconds, or `null` when the header is absent or unusable.
 *
 * Null rather than 0: a caller that read "no header" as "retry immediately" would walk
 * straight back into the ban it was just given.
 */
export function retryAfterSeconds(header: string | undefined, now: Date): number | null {
  if (header === undefined) return null;
  const value = header.trim();
  if (value === "") return null;

  // RFC 9110 §10.2.3 allows delay-seconds or an HTTP-date. Wordfence sends the first
  // form; the second is handled because reading `Thu, 20 Aug 2026 …` as NaN seconds
  // would silently become "no wait recorded".
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);

  // Every HTTP-date carries a weekday and a month name. Without this guard `Date.parse`
  // reads `-1` as the year 1 BCE, which clamps to 0 below and would tell the caller to
  // retry immediately — the one answer a block must never produce.
  if (!/[A-Za-z]/.test(value)) return null;
  const when = Date.parse(value);
  if (Number.isNaN(when)) return null;
  // A date already past means the ban has expired between the response and this call.
  return Math.max(0, Math.round((when - now.getTime()) / 1000));
}
