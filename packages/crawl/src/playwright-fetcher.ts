/**
 * The second implementation of `CrawlFetcher` (PRD §5, `crawler_mode = 'playwright'`):
 * the same GET, answered with the DOM after the page's JavaScript has run.
 *
 * **Why it exists.** Step 7's full prod crawl of integrity.com reported 538 orphans and
 * ~89% of them were false. 480 were pages whose only inbound links do not exist in
 * server-rendered HTML: `/about-us/our-partners/` serves 70 KB with one `/partner/`
 * href and zero partner slugs even inside its JS payloads while the site has 274
 * partner pages, and `/inspire/?sf_paged=16` serves 90 KB whose only 12 `inspire` links
 * are pagination, because Search & Filter Pro renders results client-side. PRD §5's
 * "server-rendered WordPress, so links are in the HTML" holds for article bodies and
 * fails for directories and filtered archives.
 *
 * **It returns what `createHttpFetcher` returns**, so nothing downstream changes:
 * status, lowercased headers, and a body only when the server said it served a page.
 * `extractPage` cannot tell the two apart, which is the point — the difference is what
 * is *in* the body, not its shape.
 *
 * **What it costs.** Measured 2026-08-26 against the local fixture server, 10 fetches
 * per case, against `createHttpFetcher` on the same URLs:
 *
 * | page                                     | undici | chromium |    ratio |
 * | ---------------------------------------- | ------ | -------- | -------- |
 * | the partner directory (doc + JS + XHR)   |  2.3ms |    853ms |    371x  |
 * | a partner page (document only)           |  2.0ms |    585ms |    292x  |
 * | a 404 (short-circuited, never rendered)  |  1.7ms |     69ms |     40x  |
 *
 * plus 2.4s for the first launch of a session and ~0.5s warm. Roughly 500ms of every
 * rendered page is the quiet period `networkidle` waits out, which is why the 404 —
 * which is never rendered — is an order of magnitude cheaper than the rest.
 *
 * **At PRD §5.1's 1 req/s the limiter still sets the pace, but only just**: 853ms of
 * work inside a 1,000ms slot. A site whose `rate_limit` is raised above ~1.2 req/s is
 * paced by the browser rather than by the limiter, and the crawl quietly stops
 * obeying the number in the registry. What is *not* free at any rate is requests: a
 * browser fetches subresources, and PRD §5.1's budget counts requests to one host, not
 * page loads. See `BLOCKED_RESOURCES`.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { isHtmlContentType } from "./record.js";
import { USER_AGENT } from "@link-graph/core";
import { type CrawlFetcher, type FetchResult } from "./fetcher.js";

/**
 * Resource types that cannot contain an `<a href>` and are therefore requests bought
 * with no link found.
 *
 * This is a rate-limiting control, not a speed one. The limiter counts one `get()`, so
 * everything the browser does inside one lands on the same Wordfence that returns 503
 * at ~8 req/s and bans the IP for an hour (PRD §5.1). Scripts and XHR are deliberately
 * *not* blocked: they are the whole reason this fetcher exists. Measured on the partner
 * fixture: 3 requests per page (document, bundle, `admin-ajax`) against the HTTP
 * fetcher's 1, and the browser's own cache collapses the shared bundle across pages.
 */
const BLOCKED_RESOURCES = new Set(["image", "media", "font", "stylesheet"]);

/** The same bound `createHttpFetcher` uses, applied to each phase of a page load. */
const TIMEOUT_MS = 30_000;

interface Session {
  readonly browser: Browser;
  readonly context: BrowserContext;
}

/** What the navigation response said, before the browser did anything with it. */
interface Captured {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly parsable: boolean;
}

/**
 * **The browser is launched on the first `get`, not here.** `crawl` builds its fetcher
 * before it opens the crawl row and releases it on every path including a throw, so a
 * refused crawl would otherwise pay 2.4s to start a Chromium it never asks for, and a
 * `release` that raced the launch would leave the process running.
 */
export function createPlaywrightFetcher(): CrawlFetcher {
  let session: Promise<Session> | null = null;
  let closed = false;

  const open = (): Promise<Session> => {
    session ??= launch();
    return session;
  };

  return {
    async close(): Promise<void> {
      closed = true;
      const started = session;
      session = null;
      if (started === null) return;
      // A launch that failed has already been reported to the `get` that triggered it;
      // re-throwing it from `close` would replace the crawl's real error with this one.
      const live = await started.catch(() => null);
      await live?.browser.close();
    },

    async get(url: string): Promise<FetchResult> {
      if (closed) {
        // Not a transport error: a fetch after release is a bug in the caller, and
        // reporting it as "the host is down" would end the crawl as a plausible
        // partial instead of a loud one.
        throw new Error(`createPlaywrightFetcher: fetcher is closed, cannot get ${url}`);
      }
      const { context } = await open();
      const page = await context.newPage();
      try {
        return await load(page, url);
      } finally {
        await page.close();
      }
    },
  };
}

async function launch(): Promise<Session> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    // The user agent `createHttpFetcher` was measured with (200 from Wordfence,
    // 2026-08-24). The two fetchers crawl the same estate and must be attributable to
    // one crawler in its logs, and this is the only string measured against its WAF.
    // Unmeasured, and worth watching on the first live playwright crawl: client-side
    // code that branches on the user agent sees a name no browser sends.
    userAgent: USER_AGENT,
  });
  return { browser, context };
}

async function load(page: Page, url: string): Promise<FetchResult> {
  // A mutable holder rather than two `let`s: TypeScript does not track assignments
  // made inside the route handler, so a plain `let` reads as `null` for ever after.
  const state: { response: Captured | null; failure: string | null } = {
    response: null,
    failure: null,
  };

  await page.route("**/*", async (route) => {
    const request = route.request();
    if (BLOCKED_RESOURCES.has(request.resourceType())) {
      await route.abort();
      return;
    }
    const isMainDocument =
      request.isNavigationRequest() && request.frame().parentFrame() === null;
    if (!isMainDocument) {
      await route.continue();
      return;
    }
    if (state.response !== null) {
      // A second main-frame navigation is the page redirecting itself — `location =`,
      // or a meta refresh. Following it would return one URL's identity with another
      // URL's DOM, and the crawl would record links that are not on the page it asked
      // for. Refused for the same reason an HTTP redirect is not followed here.
      await route.abort("aborted");
      return;
    }
    try {
      // `maxRedirects: 0` is the contract this layer owes `fetch-page.ts`: which
      // redirect is an alias hop and which is a `pages.redirect_to` needs the site's
      // alias set. A browser left to itself would follow the chain, fetch and render
      // the target, and hand back a 200 for a URL that answered 301.
      const response = await route.fetch({ maxRedirects: 0, timeout: TIMEOUT_MS });
      const headers = describeBody(response.headers());
      const status = response.status();
      const parsable = isParsable(status, headers);
      state.response = { status, headers, parsable };
      if (parsable) {
        await route.fulfill({ response });
        return;
      }
      // Nothing will read this body — `recordPage` parses only a 2xx HTML response —
      // so it is dropped rather than rendered. A WordPress 404 is the whole site nav,
      // and rendering one would cost its scripts and its XHR as well.
      await response.dispose();
      await route.fulfill({ status: 200, contentType: "text/html", body: "" });
    } catch (error) {
      // Chromium reports every network failure to `page.goto` as `net::ERR_FAILED`,
      // which cannot tell a dead host from a refused connection from a timeout. The
      // cause exists only here, and `packages/truth` records why losing it matters.
      state.failure = message(error);
      await route.abort("failed");
    }
  });

  try {
    // `commit` rather than a load state: the response is in hand as soon as the
    // navigation commits, and what to wait for after that depends on what it said.
    await page.goto(url, { waitUntil: "commit", timeout: TIMEOUT_MS });
  } catch (error) {
    return { kind: "transport-error", detail: state.failure ?? message(error) };
  }

  const response = state.response;
  if (response === null) {
    // The route handler runs on every main-frame navigation, so a commit without one
    // means the page went somewhere this function did not send it.
    throw new Error(`createPlaywrightFetcher: ${url} committed with no response seen`);
  }
  if (!response.parsable) {
    return {
      kind: "response",
      status: response.status,
      headers: response.headers,
      body: "",
    };
  }

  try {
    /**
     * **`networkidle`, and the fixture is built to prove why.** The measured failure is
     * an empty container filled by an `admin-ajax` call, so every earlier state is
     * wrong by construction: `domcontentloaded` and `load` both fire before the results
     * arrive, and returning then would hand `extractPage` a page with no items — zero
     * links that read as a leaf, which is the orphan-manufacturing bug this fetcher
     * exists to remove. Measured on the partner fixture (Chromium 131, 2026-08-26):
     * `load` finds 0 of the 4 partner links, `networkidle` finds 4.
     *
     * The cost of choosing it is that a page which never goes quiet — a poller, a chat
     * widget — fails instead of returning a half-built DOM. That is deliberate under
     * engineering guide §1, and it is loud: `crawl` stops the host and the run is
     * `partial`. Whether this estate has such a page is unmeasured; the first live
     * playwright crawl is what would find out.
     */
    await page.waitForLoadState("networkidle", { timeout: TIMEOUT_MS });
  } catch (error) {
    return {
      kind: "transport-error",
      detail:
        `${url} loaded but never went quiet within ${TIMEOUT_MS}ms, so its DOM is ` +
        `half-built and the links it would report are not the links it has: ` +
        `${message(error)}`,
    };
  }

  return {
    kind: "response",
    status: response.status,
    headers: response.headers,
    // The rendered DOM, serialized — the whole point of this fetcher. Comments survive
    // it, which matters: step 2 found a commented-out `<a href>` that must stay
    // invisible to `extractPage`.
    body: await page.content(),
  };
}

/**
 * The response headers, minus the two that describe bytes this fetcher no longer has.
 *
 * The body returned is a re-serialization of the DOM, not the transferred entity, so
 * `content-encoding` and `content-length` describe something else. Keeping the first
 * would be worse than untidy: `recordPage` refuses a body served with an encoding the
 * crawler did not ask for, because undici would have handed cheerio bytes — and the
 * browser has already decoded it. Every gzipped page on the estate, which is all of
 * them, would be refused.
 */
function describeBody(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name === "content-encoding" || name === "content-length") continue;
    // Playwright lowercases names and joins a repeated header with ", " (verified
    // 2026-08-26 on a doubled `x-robots-tag`), which is the same shape `createHttpFetcher`
    // produces and the shape `headerNoindex` parses.
    kept[name] = value;
  }
  return kept;
}

/** `readBody`'s rule in `fetcher.ts`, applied before the browser renders anything. */
function isParsable(status: number, headers: Readonly<Record<string, string>>): boolean {
  return status >= 200 && status < 300 && isHtmlContentType(headers["content-type"]);
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
