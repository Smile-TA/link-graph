/**
 * Verified, broken, or "we could not tell" — the most consequential rule in this
 * package, as a pure function.
 *
 * It is a sibling of `packages/crawl/src/verdict.ts` on purpose. That file exists because
 * a crawl that ended early must never be reported as a finished one; this one exists
 * because **someone else's bot protection must never be reported as our broken link**.
 * They are the same idea pointed at two different I/O boundaries, and both are here
 * rather than inside the loop so that their edge cases can be exercised with nothing
 * running.
 *
 * PRD §6.1 states the requirement in one line — "Third-party 429/403 is recorded as
 * _unverified_, never as _broken_" — and every shape below was measured from lychee
 * 0.24.2 against a local server and, where it could be, against the estate's own
 * external URLs (see `test/fixtures/README.md`).
 */
import type { LinkcheckCounts } from "./summary.js";

export type LinkOutcome =
  /** The checker got an HTTP response, after following any redirects. */
  | { readonly kind: "status"; readonly statusCode: number }
  /** DNS, TCP or TLS failed. No status code exists, and none is invented. */
  | { readonly kind: "network"; readonly detail: string }
  | { readonly kind: "timeout"; readonly detail: string }
  /**
   * The checker declined to request the URL at all. Measured: lychee excludes
   * `twitter.com` and `example.com` with **no `--exclude` configured**, and reports it
   * as "This is due to your 'exclude' values" — a message that blames a config we never
   * wrote. `https://twitter.com/IntegrityMG` is one of integrity.com's real 642.
   */
  | { readonly kind: "refused-by-checker"; readonly detail: string }
  /**
   * The report said nothing usable about this URL: it was absent, or the entry named a
   * different URL than the one requested. Measured on the real 642 —
   * `…/company/integrity-marketing.` comes back as `…/company/integrity-marketing`,
   * because lychee extracts links from text and a trailing dot is punctuation to it —
   * and a check of a neighbouring URL is not a check of this one.
   */
  | { readonly kind: "not-checked"; readonly detail: string };

export interface ExternalUrlVerdict {
  /** What the server said, or `null` when nothing got that far. Never invented. */
  readonly statusCode: number | null;
  /** True when this response says nothing about whether the link works. */
  readonly unverified: boolean;
  /**
   * Why, when `unverified`. Non-null exactly when `unverified` is true, which
   * `012_external_url_detail.sql` also enforces as a CHECK: "their bot protection
   * refused us" and "our own egress is broken" are the same word with different
   * remedies, and a run cannot record the first if it cannot distinguish it.
   */
  readonly detail: string | null;
}

/**
 * The only two statuses that make a claim about the resource rather than about us.
 *
 * **This is deliberately narrower than the internal rule**, which is `status_code >= 400`
 * (`BROKEN_INTERNAL_EDGE` in packages/db). The asymmetry is the whole point of §6.1's
 * third-party clause: for an internal page we own the server, so a 403 is a fact about
 * the page; for a third party a 403 is a fact about their WAF and our IP. 404 and 410
 * are the two codes whose meaning survives that — RFC 9110 §15.5.5 and §15.5.11 both
 * describe the target resource, not the requester.
 *
 * What this gives up, stated rather than hidden: a destination that has been answering
 * 500 for a month reads `unverified` forever and never becomes a finding. That is the
 * safe direction under engineering guide §1 — a reader chases nothing rather than
 * chasing a false positive — but it is a real gap, and closing it needs history
 * (`external_urls` keeps one row per URL, so "500 on every check for a month" is not a
 * question this schema can answer yet).
 */
const RESOURCE_IS_ABSENT = new Set([404, 410]);

/**
 * Why an HTTP status that is not 2xx/3xx and not 404/410 tells us nothing. Written as
 * text rather than a code because it is what lands in `external_urls.detail` and gets
 * read by a person.
 */
function statusIsInconclusive(statusCode: number): string | null {
  if (statusCode < 400) return null;
  if (RESOURCE_IS_ABSENT.has(statusCode)) return null;
  if (statusCode === 401 || statusCode === 403 || statusCode === 407) {
    return `HTTP ${String(statusCode)}: the host refused us access, which says nothing about whether the link works for a visitor`;
  }
  if (statusCode === 429) {
    // The estate's own measured shape, from the other side: Wordfence answers 503 with
    // retry-after 3600 above ~8 req/s (PRD §5.1). A third party's rate limit is the same
    // fact about our request rate rather than about their page.
    return `HTTP 429: the host rate-limited us, which describes our request rate rather than the link`;
  }
  if (statusCode >= 500) {
    return `HTTP ${String(statusCode)}: the host failed to serve the page, which may be transient and is not evidence the link is wrong`;
  }
  return `HTTP ${String(statusCode)}: neither a success nor a claim that the resource is absent, so nothing can be concluded`;
}

export function externalUrlVerdict(outcome: LinkOutcome): ExternalUrlVerdict {
  if (outcome.kind === "status") {
    const inconclusive = statusIsInconclusive(outcome.statusCode);
    return {
      statusCode: outcome.statusCode,
      unverified: inconclusive !== null,
      detail: inconclusive,
    };
  }
  // Every remaining kind is a way of not having an answer, and each carries the
  // checker's own words: a paraphrase is a string nobody can search for in lychee's
  // source when the same message turns up on 40 URLs.
  const prefix: Record<Exclude<LinkOutcome["kind"], "status">, string> = {
    network: "the request never completed",
    timeout: "the request timed out",
    "refused-by-checker": "the checker declined to request this URL",
    "not-checked": "the checker reported nothing usable for this URL",
  };
  return {
    statusCode: null,
    unverified: true,
    detail: `${prefix[outcome.kind]}: ${outcome.detail}`,
  };
}

/**
 * Whether this row is a finding. Read from the stored verdict rather than recomputed
 * from the status code, for the reason `listOrphanFindings` reads `pages.class` instead
 * of re-deriving PRD §2: two implementations of one rule is how a report comes to
 * disagree with the table it prints beside.
 */
export function isBrokenExternal(verdict: ExternalUrlVerdict): boolean {
  return !verdict.unverified && verdict.statusCode !== null && verdict.statusCode >= 400;
}

/**
 * URLs the run handed to the checker (`checked`), and of those, how many got an
 * answer that means something — 2xx/3xx, 404 or 410 (`conclusive`).
 */
export type LinkcheckProgress = Pick<LinkcheckCounts, "checked" | "conclusive">;

export interface LinkcheckVerdict {
  readonly status: "complete" | "partial";
  /** The reason, `null` exactly when the status is `complete`. */
  readonly stoppedBecause: string | null;
}

/**
 * Whether a run learned anything at all.
 *
 * **This exists because `last_checked` is what the TTL reads.** A run made with no
 * network egress comes back with every URL `unverified`; writing those rows would stamp
 * all 642 as checked-just-now and suppress every recheck for a whole TTL window, while
 * the run itself exits reporting zero broken links. That is engineering guide §1's
 * opening bug with a week-long blast radius, so a run that could tell nothing writes
 * nothing.
 *
 * It is a floor, not a threshold, and deliberately so: 100 unverified out of 642 is
 * written, because those hosts really did refuse us and the count is surfaced instead.
 * Where between 1 and 642 the honest cut-off lies is a question about how often
 * third-party hosts block us, which needs a full estate run to answer and has none yet.
 */
export function linkcheckVerdict(progress: LinkcheckProgress): LinkcheckVerdict {
  const { checked, conclusive } = progress;
  // Nothing due is not a failure: the TTL is doing its job and the caller is told the
  // number so it cannot print "0 broken" as though 642 had been checked.
  if (checked === 0) return { status: "complete", stoppedBecause: null };
  if (conclusive > 0) return { status: "complete", stoppedBecause: null };
  return {
    status: "partial",
    stoppedBecause:
      `not one of the ${String(checked)} URLs checked produced a usable answer, which ` +
      `is the shape of our own network egress being broken rather than of ${String(checked)} ` +
      `dead destinations. Nothing was written: recording these as checked would stamp ` +
      `last_checked on all of them and suppress every recheck for a whole TTL window`,
  };
}
