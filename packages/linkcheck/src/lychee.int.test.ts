/**
 * The real lychee binary against the fixture server — every response shape PRD §6.1
 * cares about, end to end, with no third party involved.
 *
 * The server is `packages/crawl`'s (`startFixtureServer`), reused rather than duplicated.
 * The crawler could keep node identity while doing this, because its fetcher rewrites the
 * origin in process; **a subprocess cannot**, so these URLs are the local origin itself.
 * What that gives up is a real hostname in the row; what it keeps is real sockets, real
 * status lines and real headers, which is what the classification is about.
 *
 * Two of the assertions need no network at all, and they are the two that matter most:
 * `twitter.com` is excluded by lychee before any request is made, and a URL with a
 * trailing dot is rewritten before any request is made. Both are real estate URLs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServer } from "@link-graph/crawl";
import { resolveLycheeBinary } from "./binary.js";
import { createLycheeRunner, type LycheeRunner } from "./lychee.js";
import { reconcile } from "./report.js";
import { externalUrlVerdict, isBrokenExternal } from "./verdict.js";

const HOST = "linkcheck.fixture";

/** One path per response shape, each one a shape this estate or a third party serves. */
const RESPONSES: Readonly<
  Record<string, { status: number; headers?: Record<string, string> }>
> = {
  "/live/": { status: 200, headers: { "content-type": "text/html" } },
  "/moved/": { status: 301, headers: { location: "/live/" } },
  "/gone/": { status: 404, headers: { "content-type": "text/html" } },
  "/forbidden/": { status: 403, headers: { "content-type": "text/html" } },
  "/ratelimited/": { status: 429, headers: { "retry-after": "60" } },
  // Wordfence's measured shape (PRD §5.1): 503 with a one-hour retry-after.
  "/blocked/": { status: 503, headers: { "retry-after": "3600" } },
  "/boom/": { status: 500, headers: { "content-type": "text/html" } },
};

let server: FixtureServer;
let runner: LycheeRunner;
let origin: string;

beforeAll(async () => {
  server = await startFixtureServer({
    [HOST]: (path) => {
      const answer = RESPONSES[path];
      if (answer === undefined) return { status: 404, body: "" };
      return {
        status: answer.status,
        headers: answer.headers ?? {},
        body: "<html>x</html>",
      };
    },
  });
  origin = server.originFor(HOST);
  runner = createLycheeRunner({
    binaryPath: resolveLycheeBinary(process.env),
    // 10ms rather than the 1s default: the pacing itself is lychee's and is measured in
    // its own test below, and a suite that waits a second per URL is a suite nobody runs.
    hostIntervalMs: 10,
    requestTimeoutSeconds: 3,
    runTimeoutMs: 60_000,
  });
});

afterAll(async () => {
  await server.close();
});

/** One verdict per URL, in the order asked, through the real binary. */
const verdictsFor = async (urls: readonly string[]) =>
  reconcile(urls, await runner.run(urls)).map((result) => {
    const verdict = externalUrlVerdict(result.outcome);
    return { url: result.url, ...verdict, broken: isBrokenExternal(verdict) };
  });

describe("createLycheeRunner", () => {
  /**
   * The §1 table. Every row that is not 404 must come back `unverified` with a reason,
   * because every one of them is a finding somebody chases if it lands in a report.
   */
  it("classifies every response shape, and only the 404 is broken", async () => {
    const verdicts = [
      ...(await verdictsFor([
        `${origin}/live/`,
        `${origin}/moved/`,
        `${origin}/gone/`,
        `${origin}/forbidden/`,
        `${origin}/boom/`,
        // Nothing listens on port 1, so this is a connection failure, not a status.
        "http://127.0.0.1:1/refused/",
        // https onto the plaintext fixture server: a real TLS handshake failure.
        `https://127.0.0.1:${new URL(origin).port}/live/`,
      ])),
      // **A run of its own each, and that is a measured requirement rather than tidiness.**
      // lychee's per-host interval is adaptive: a 429 or 503 carrying `retry-after` — 60
      // and 3600 here, the shapes a real rate limiter and Wordfence send — raises the
      // interval for that host for the rest of the run, capped at a minute. Timed:
      // eleven local URLs with one 429 among them took 103 seconds instead of two. Since
      // lychee keys the backoff on the hostname, every fixture path shares it, so these
      // two are asked on their own where there is no later request to stall.
      ...(await verdictsFor([`${origin}/ratelimited/`])),
      ...(await verdictsFor([`${origin}/blocked/`])),
    ];

    expect(verdicts.map((v) => [v.statusCode, v.unverified, v.broken])).toEqual([
      [200, false, false], // /live/
      [200, false, false], // /moved/ — the 301 is followed, so the status is where it lands
      [404, false, true], // /gone/ — the only broken link here
      [403, true, false], // bot protection is never a broken link (PRD §6.1)
      [500, true, false],
      [null, true, false], // connection refused
      [null, true, false], // TLS handshake
      [429, true, false],
      [503, true, false],
    ]);
    // Every unverified row says why, which 012_external_url_detail.sql also insists on.
    for (const verdict of verdicts) {
      if (verdict.unverified) expect(verdict.detail).toMatch(/\S/);
      else expect(verdict.detail).toBeNull();
    }
  });

  /**
   * Both measured against integrity.com's real 642 external URLs, and both make **zero**
   * network requests — lychee decides them before it would dial.
   */
  it("never passes a URL it excluded itself or rewrote before checking", async () => {
    const urls = [
      // Excluded by lychee with no --exclude configured, reported as "due to your
      // 'exclude' values". A real external URL of integrity.com.
      "https://twitter.com/IntegrityMG",
      // The real trailing-dot URL, aimed at the fixture host so that a request, if one
      // were made, would be local. lychee strips the dot and checks a different URL.
      `${origin}/live/.`,
    ];
    const before = server.requests.length;
    const results = reconcile(urls, await runner.run(urls));

    expect(results.map((r) => r.outcome.kind)).toEqual([
      "refused-by-checker",
      "not-checked",
    ]);
    for (const result of results) {
      const verdict = externalUrlVerdict(result.outcome);
      expect(verdict.unverified).toBe(true);
      expect(isBrokenExternal(verdict)).toBe(false);
    }
    // The rewritten URL was requested — as the URL lychee chose, not as the one we
    // asked about — so exactly one request reached the host and none of it counts as an
    // answer about our URL.
    expect(server.requests.slice(before).map((r) => r.replace(HOST, ""))).toEqual([
      "/live/",
    ]);
  });

  it("paces requests to one host at the interval it was given", async () => {
    const paced = createLycheeRunner({
      binaryPath: resolveLycheeBinary(process.env),
      hostIntervalMs: 400,
      requestTimeoutSeconds: 3,
      runTimeoutMs: 60_000,
    });
    const urls = ["/live/", "/moved/", "/gone/"].map((path) => `${origin}${path}`);
    const started = Date.now();
    await paced.run(urls);
    // Three requests at 400ms apart is two gaps. Asserted as a floor rather than a
    // window: PRD §5.1's requirement is a minimum interval, and a slow machine making it
    // slower is not a failure.
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
  });

  /**
   * A run that cannot finish must be loud. lychee prints its JSON only at the end, so a
   * killed run has nothing to salvage — and, measured, one 429 carrying `retry-after`
   * raises its per-host interval to as much as a minute per request, which is how a run
   * comes to need killing in the first place.
   */
  it("refuses, rather than returning nothing, when the run outlasts its timeout", async () => {
    const impatient = createLycheeRunner({
      binaryPath: resolveLycheeBinary(process.env),
      hostIntervalMs: 5_000,
      requestTimeoutSeconds: 3,
      runTimeoutMs: 300,
    });
    const urls = ["/live/", "/moved/", "/gone/"].map((path) => `${origin}${path}`);
    await expect(impatient.run(urls)).rejects.toThrow(/did not finish within 300ms/);
  });

  it("refuses a binary that is not there, rather than checking nothing", async () => {
    const missing = createLycheeRunner({ binaryPath: "/nonexistent/lychee" });
    await expect(missing.run([`${origin}/live/`])).rejects.toThrow(
      /cannot run lychee at \/nonexistent\/lychee/,
    );
  });

  it("refuses a URL containing a line break, which would shift every other result", async () => {
    await expect(runner.run([`${origin}/live/\n${origin}/gone/`])).rejects.toThrow(
      /line break/,
    );
  });
});
