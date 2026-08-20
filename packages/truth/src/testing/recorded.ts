/**
 * A fetcher over the recorded responses in `packages/truth/test/fixtures`.
 *
 * Every response there is an unmodified production response captured at 1 req/s
 * (PRD §5.1); `recorded.json` names the URL each one came from. Unit tests never touch
 * the network (engineering guide §4.2), and an unrecorded URL is an error rather than a
 * 404 — a test whose subject silently asked for something we never recorded would
 * otherwise pass by taking the "absent" branch.
 *
 * URLs are matched on origin + path + *sorted* query parameters, because a recorded URL
 * and the one the resolver builds can order `page` and `_fields` differently while
 * naming the same resource.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HttpResult, TruthDeps } from "../http.js";

interface RecordedResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const DIR = new URL("../../test/fixtures/", import.meta.url);

const MANIFEST: readonly RecordedResponse[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("recorded.json", DIR)), "utf8"),
) as RecordedResponse[];

/** origin + path + sorted query — see the note above on parameter order. */
export function responseKey(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.sort();
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

const BY_KEY = new Map(MANIFEST.map((r) => [responseKey(r.url), r]));

/**
 * Bodies read once, however many tests ask for them. The fixtures total ~740 KB and the
 * unit tier reads some of them a dozen times — `agent.familyfirstlife.com`'s first
 * sitemap child alone is 235 KB and 2,000 entries. Same reason as the cache in
 * `packages/db/src/testing/captures.ts`.
 */
const bodies = new Map<string, string>();

function bodyOf(recorded: RecordedResponse): string {
  const cached = bodies.get(recorded.body);
  if (cached !== undefined) return cached;
  const text = readFileSync(fileURLToPath(new URL(recorded.body, DIR)), "utf8");
  bodies.set(recorded.body, text);
  return text;
}

function lookup(url: string): RecordedResponse {
  const recorded = BY_KEY.get(responseKey(url));
  if (recorded === undefined) {
    throw new Error(
      `no recorded response for ${url}. Capture it at 1 req/s and add it to ` +
        `packages/truth/test/fixtures rather than letting this test take the ` +
        `"absent" branch.`,
    );
  }
  return recorded;
}

export interface RecordedFetcherOptions {
  /**
   * Hosts — or single URLs — that answer with a transport failure, as the two dead
   * estate hosts do. One URL rather than a whole host is the interesting case: a host
   * that answers one probe and drops the other is where "we could not ask" gets
   * confused with "there is nothing to ask for".
   */
  readonly unreachable?: readonly string[];
  /**
   * A deliberate plant: serve the response recorded for one URL when another is asked
   * for. Used to compose a site shape no estate host was measured to have — every
   * response is still real, only the pairing is planted (the pattern step 4 used for
   * its planted anomalies).
   */
  readonly substitute?: Readonly<Record<string, string>>;
  /**
   * Header names to remove from every recorded response. The estate sits behind
   * CloudFront, so a header the resolver depends on crosses an intermediary that may not
   * forward it; this is how that is tested without inventing a response body.
   */
  readonly stripHeaders?: readonly string[];
}

export interface RecordedFetcher extends TruthDeps {
  /** Every URL asked for, in order. */
  readonly requested: string[];
}

export function recordedFetcher(options: RecordedFetcherOptions = {}): RecordedFetcher {
  const requested: string[] = [];
  const unreachable = new Set(options.unreachable ?? []);
  // Keyed the same way as the manifest, so a plant written with the parameters in one
  // order still matches the URL the resolver builds.
  const stripped = new Set((options.stripHeaders ?? []).map((h) => h.toLowerCase()));
  const substitute = new Map(
    Object.entries(options.substitute ?? {}).map(([from, to]) => [responseKey(from), to]),
  );
  return {
    requested,
    get(url: string): Promise<HttpResult> {
      requested.push(url);
      const parsed = new URL(url);
      if (unreachable.has(parsed.hostname) || unreachable.has(responseKey(url))) {
        return Promise.resolve({
          kind: "transport-error",
          detail: "fetch failed: ENOTFOUND",
        });
      }
      const recorded = lookup(substitute.get(responseKey(url)) ?? url);
      return Promise.resolve({
        kind: "response",
        status: recorded.status,
        headers: Object.fromEntries(
          Object.entries(recorded.headers).filter(([name]) => !stripped.has(name)),
        ),
        body: bodyOf(recorded),
      });
    },
  };
}

/** The recorded body for one URL, for the pure-parser tests. */
export function recordedBody(url: string): string {
  return bodyOf(lookup(url));
}

export function recordedResponse(url: string): RecordedResponse {
  const recorded = lookup(url);
  return { ...recorded, body: bodyOf(recorded) };
}
