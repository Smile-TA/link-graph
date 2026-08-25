/**
 * 403bplan.net as a whole site for the integration tier: its truth source *and* its 13
 * pages, from one local host.
 *
 * The command under test resolves the truth source over HTTP and then crawls over HTTP,
 * so a fixture that answered only one of the two would leave the seam between step 5 and
 * step 6 — the thing this step wires — untested. Both halves are production responses
 * captured at 1 req/s and already checked in: the pages by step 6 (`serve403bplan`,
 * which serves them here rather than a fourth copy of the URL→file table), and the five
 * truth-source responses by step 5 (`packages/truth/test/fixtures`).
 *
 * **The recorded truth responses are read here rather than through `packages/truth`'s
 * own `recordedFetcher`.** That fetcher answers by URL and never opens a socket, which is
 * what step 5 needed and the opposite of what this needs: the point of the fixture server
 * is that the command's real fetcher makes a real request over a real connection. The
 * manifest lookup is duplicated as a result — reported rather than lifted, since sharing
 * it means reworking a committed step-5 helper whose only outcome for an unrecorded URL
 * is to throw, and this one has to fall through to the page handler.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve403bplan, HOST, type FixtureHandler } from "@link-graph/crawl";
import type { FixtureResponse } from "@link-graph/crawl";

export { HOST } from "@link-graph/crawl";

interface RecordedResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Path of the body file, relative to the fixture directory. */
  readonly body: string;
}

const DIR = new URL("../../../truth/test/fixtures/", import.meta.url);

/**
 * Path + sorted query. `resolveTruthSource` builds `?page=2&_fields=…` in an order the
 * recorded URL does not necessarily share, and they name the same resource — the same
 * rule `packages/truth`'s own lookup applies, for the same reason.
 */
function key(url: string): string {
  const parsed = new URL(url, `https://${HOST}`);
  parsed.searchParams.sort();
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Headers that describe bytes this server is not sending. The captures store the
 * *decoded* body while the recorded headers still say `content-encoding: gzip` with the
 * compressed length, so replaying them verbatim would hand the client a gzip frame that
 * is plain text — a failure with nothing to do with anything under test. Everything the
 * resolver reads (`content-type`, `x-wp-total`, `x-wp-totalpages`, `link`, `location`) is
 * passed through untouched.
 */
const FRAMING = new Set(["content-encoding", "content-length", "transfer-encoding"]);

/**
 * The five truth-source responses, read and rewritten once at import rather than per
 * request: the handler runs inside the event loop the crawler and the Postgres client
 * share, and a synchronous file read there is work with no reason to happen twice.
 */
const TRUTH = new Map<string, FixtureResponse>(
  (
    JSON.parse(
      readFileSync(fileURLToPath(new URL("recorded.json", DIR)), "utf8"),
    ) as readonly RecordedResponse[]
  )
    .filter((recorded) => new URL(recorded.url).host === HOST)
    .map((recorded) => [
      key(recorded.url),
      {
        status: recorded.status,
        headers: Object.fromEntries(
          Object.entries(recorded.headers).filter(([name]) => !FRAMING.has(name)),
        ),
        body: readFileSync(fileURLToPath(new URL(recorded.body, DIR)), "utf8"),
      },
    ]),
);

/** The site as its origin answers it: five truth-source URLs, then the 13 pages. */
export const serve403bplanSite: FixtureHandler = (path: string): FixtureResponse =>
  TRUTH.get(key(path)) ?? serve403bplan(path);
