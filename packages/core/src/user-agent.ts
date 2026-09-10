/**
 * The identity every requester of the estate presents, so a WAF rule written against
 * one requester applies to all of them (originally `packages/crawl/src/fetcher.ts`'s
 * doc comment, which named the same reasoning for `createPlaywrightFetcher`).
 *
 * Measured 2026-09-02: three of the estate's most likely blockers —
 * `www.facebook.com/IntegrityMG`, `www.linkedin.com/company/integrity-marketing-/`,
 * `www.instagram.com/integritymktg/` — answer 200 under this user-agent, the same as
 * under lychee's own default.
 */
export const USER_AGENT = "link-graph/0.1 (+link audit)";
