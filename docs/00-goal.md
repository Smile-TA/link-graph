# link-graph — Project Goal

## The gap

We run ~165 production WordPress sites. Our Playwright suite checks **10 pages per
site**, and it discovers those pages from the WordPress `pages` post type alone.

On integrity.com that post type holds 96 of 1,953 sitemap URLs. Ten sampled pages
drawn from five percent of the site is coverage of roughly **0.5%**. The remaining
1,857 URLs — 477 blog entries, 400 team members, 285 podcasts, 272 partners — have
never been checked by anything.

Full census of all 165 registered production hostnames (see `census.json`): 95 have a
readable sitemap totalling **18,531 URLs**. The median site holds just 27 URLs, and the
ten largest sites account for 73% of the total. True crawl surface is larger, since
sitemaps omit noindex pages, paginated archives, and feeds.

Of the 70 sites with no sitemap, 10 expose a working WP REST API, 47 are reachable but
expose neither (mostly `*.planenroll.com` funnels, rate calculators and APIs rather than
content sites), and 12 are unreachable. Sites with no truth source can be checked for
broken links and structure but **cannot have orphans detected at all**.

This is a small estate by crawler standards. The binding constraint is not volume but
Wordfence throttling, which returns 503 above roughly 8 req/s sustained per host — and
applies per host, so crawling many sites concurrently is nearly free.

For every page outside that sample, we have no answer to even basic questions: is
anything linking to it, do its links work, where does it sit in the site. Reporting
lives in ~165 separate GitHub Pages repos with no cross-site view and no history, so
"did this get better or worse" is not a question anyone can currently ask.

Commercial crawlers (Screaming Frog, Sitebulb) solve the single-site case well, but
they run one site at a time, store results locally, and cannot see our CMS — so they
can never tell us about a published page that nothing links to.

## Elevator pitch

**link-graph is a centralized link intelligence service for our WordPress estate.**
It crawls every page of every site, reconciles what it finds against each site's
WordPress REST API, and keeps the results in one queryable database over time.

Because it reads the CMS rather than guessing from links alone, it can find pages
that exist but are unreachable — the one thing a link crawler fundamentally cannot
do on its own.

## The five questions it answers

1. **What exists that nothing links to?** — true orphans (published, zero inbound),
   soft orphans (reachable only from nav/footer, never from content), separated from
   pages intentionally excluded via `noindex` or canonical.
2. **What's broken, and how bad is it?** — broken links ranked by blast radius: how
   many pages point at each one.
3. **How is this site actually shaped?** — page relationships and site structure,
   readable at a glance rather than as a hairball.
4. **Where do we send people off-site?** — external links isolated from internal,
   aggregated by destination domain, checked once and shared across all sites.
5. **What changed?** — every crawl diffed against the last, stamped with the deployed
   version, so regressions are attributable to a release.

## Explicitly not

Not an SEO audit suite. No title/meta/heading analysis, no readability or spell
checking, no schema or hreflang validation, no accessibility scanning — that already
lives in pw-template, and chasing it here turns this into a worse Screaming Frog.

If a feature is not about **links, reachability, or change over time**, it is out of
scope.

## Success criteria

- 100% page coverage on every production site, versus 10 sampled pages today.
- An orphan list trustworthy enough to act on without manual re-checking — meaning
  redirect-, canonical-, and `noindex`-aware, with a false-positive rate near zero.
- Any question answerable across all sites at once, from one place.
- Deploy-to-deploy diffs, with the option to gate a release on link regressions.
- Coverage drift surfaced automatically: sites deployed but not monitored.
