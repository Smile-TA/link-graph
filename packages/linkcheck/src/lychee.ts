/**
 * The one I/O seam of this package (guide §4.2): run lychee over a list of URLs.
 *
 * lychee is a Rust static binary invoked as a subprocess (PRD §6.1, §8). Every flag
 * below was measured against lychee 0.24.2 on 2026-09-02 and each one is here for a
 * reason recorded at it — the defaults are wrong for this estate in three separate ways,
 * and two of them are silent.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { USER_AGENT } from "@link-graph/core";
import { parseLycheeReport, type LycheeReport } from "./report.js";

export interface LycheeRunner {
  /**
   * Check exactly these URLs, in this order. Line N of the checker's input is
   * `urls[N - 1]`, which is what `reconcile` joins on.
   */
  run(urls: readonly string[]): Promise<LycheeReport>;
}

export interface LycheeOptions {
  /** From `resolveLycheeBinary`. Injected, never discovered here. */
  readonly binaryPath: string;
  /**
   * Minimum gap between requests to one host. Defaults to PRD §5.1's 1 req/s, and that
   * is not merely politeness towards strangers: `is_external` is relative to the site
   * being crawled, so 20 of integrity.com's 642 external URLs are on
   * `events.integrity.com` and `leads.integrity.com` — estate hosts, behind the same
   * Wordfence that answers 503 above ~8 req/s and bans the IP for an hour.
   */
  readonly hostIntervalMs?: number;
  /**
   * Concurrent requests across all hosts. Defaults to 8, the low end of PRD §5.1's
   * "8-16 concurrent sites", rather than lychee's own 128: integrity.com's 642 external
   * URLs sit on 463 distinct hosts, so 128 in flight would be 128 sockets from one IP
   * for no gain — the per-host interval, not the global width, is what bounds the run.
   */
  readonly maxConcurrency?: number;
  /** Per-request timeout, seconds. */
  readonly requestTimeoutSeconds?: number;
  /**
   * Wall-clock ceiling for the whole subprocess.
   *
   * **Measured, and this is why it exists.** lychee's per-host interval is adaptive: one
   * 429 carrying `retry-after: 60` raised the interval for that host to a minute for the
   * rest of the run, and a `retry-after: 3600` — exactly what Wordfence sends — logged
   * "Capping the duration to 1m instead" and did the same. Timed: eleven local URLs, one
   * of them a 429, took **103 seconds** instead of under two. lychee prints its JSON only
   * at the end, so a host with 23 URLs (the estate's worst, `m.lndg.page`) can stall for
   * ~23 minutes with no output at all. 30 minutes is that worst case plus room; the
   * normal run is ~1 minute.
   */
  readonly runTimeoutMs?: number;
  /** Sent to third parties, so a host that blocks us can name us. */
  readonly userAgent?: string;
}

const DEFAULTS = {
  hostIntervalMs: 1000,
  maxConcurrency: 8,
  requestTimeoutSeconds: 20,
  runTimeoutMs: 30 * 60 * 1000,
} as const;

export function createLycheeRunner(options: LycheeOptions): LycheeRunner {
  const hostIntervalMs = options.hostIntervalMs ?? DEFAULTS.hostIntervalMs;
  const maxConcurrency = options.maxConcurrency ?? DEFAULTS.maxConcurrency;
  const requestTimeoutSeconds =
    options.requestTimeoutSeconds ?? DEFAULTS.requestTimeoutSeconds;
  const runTimeoutMs = options.runTimeoutMs ?? DEFAULTS.runTimeoutMs;
  const userAgent = options.userAgent ?? USER_AGENT;

  const args = [
    "--format",
    "json",
    "--no-progress",
    // **Load-bearing, and its absence is silent.** Measured: without `--verbose`,
    // `detailed_stats` is false and `success_map` comes back empty — so every 200 is
    // invisible and "checked and alive" is indistinguishable from "never checked".
    "--verbose",
    // **Zero retries, measured.** A 429 with lychee's default `--max-retries 3` cost
    // **four requests** to a host that had just asked us to stop, and 11 seconds. PRD
    // §5.1's rule for our own estate is to back off on the *first* 503, and a retry buys
    // nothing here anyway: a blocked or timed-out URL is `unverified` however many times
    // we ask, so the extra requests only make the next block more likely.
    "--max-retries",
    "0",
    "--host-concurrency",
    "1",
    "--host-request-interval",
    `${String(hostIntervalMs)}ms`,
    "--max-concurrency",
    String(maxConcurrency),
    "--timeout",
    String(requestTimeoutSeconds),
    "--user-agent",
    userAgent,
    // PRD §6.1: "Its own cache is redundant and stays disabled." `external_urls` owns
    // the TTL, is shared across sites and is queryable; `.lycheecache` is none of those.
    // Off by default, passed explicitly because a stale cache would answer a question
    // we thought we were asking the network.
    "--cache=false",
    // `--` so a URL beginning with a dash can never be read as a flag, then `-` for
    // stdin: the input is written to the pipe rather than to a temp file, which is what
    // makes `span.line` an index into a list we still hold.
    "--",
    "-",
  ];

  return {
    async run(urls: readonly string[]): Promise<LycheeReport> {
      if (urls.length === 0) return { total: 0, entries: [] };
      // A URL containing a newline would shift every following line by one and silently
      // re-point the whole join. Refused rather than escaped: `normalizeUrl` already
      // strips whitespace, so one arriving here means node identity is broken upstream.
      const broken = urls.find((url) => /[\r\n]/.test(url));
      if (broken !== undefined) {
        throw new Error(
          `refusing to check a URL containing a line break (${JSON.stringify(broken)}): ` +
            `the input is one URL per line and the line number is the only key back to ` +
            `the URL requested`,
        );
      }
      const { stdout, stderr, code } = await runProcess(
        options.binaryPath,
        args,
        `${urls.join("\n")}\n`,
        runTimeoutMs,
      );
      // 0 = every link passed, 2 = at least one did not. Both are complete runs. 1 is a
      // missing input or a runtime failure and 3 is a bad config file — and clap also
      // exits 2 for an unrecognised argument, printing nothing on stdout, which is why
      // the JSON is checked as well as the code.
      if (code !== 0 && code !== 2) {
        throw new Error(
          `lychee exited ${String(code)} (${options.binaryPath}): ${stderr.trim() || "no stderr"}`,
        );
      }
      const report = parseLycheeReport(stdout);
      if (report.entries.length === 0) {
        // Every URL missing is not a per-URL degradation, it is a run that did nothing.
        // Reconciliation would report 642 `not-checked` rows and `linkcheckVerdict` would
        // refuse them; saying so here names the cause instead.
        throw new Error(
          `lychee reported on none of the ${String(urls.length)} URL(s) it was given ` +
            `(total ${String(report.total)}): ${stderr.trim() || "no stderr"}`,
        );
      }
      return report;
    },
  };
}

interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

function runProcess(
  binaryPath: string,
  args: readonly string[],
  input: string,
  timeoutMs: number,
): Promise<ProcessOutput> {
  return new Promise<ProcessOutput>((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      // **Measured: a `lychee.toml` in the working directory is read and applied.** With
      // one containing `exclude = ["127\\.0\\.0\\.1"]` the URL came back `excluded`
      // instead of checked, reported as "due to your 'exclude' values". `.lycheeignore`
      // is read the same way. The repo root gaining either file would silently turn
      // checks into non-checks, so the process is run somewhere neither can appear.
      // `--config` cannot express "no config": pointing it at a missing file exits 3.
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    const timer = setTimeout(() => {
      settled = true;
      // SIGKILL, not SIGTERM: the JSON only arrives at the end, so a partially finished
      // run has nothing to salvage and there is no graceful shutdown worth waiting for.
      child.kill("SIGKILL");
      reject(
        new Error(
          `lychee did not finish within ${String(timeoutMs)}ms and was killed. It ` +
            `prints its results only at the end, so nothing was recorded — measured, a ` +
            `single 429 or 503 carrying retry-after raises its per-host interval to as ` +
            `much as a minute per request for the rest of the run. stderr: ` +
            `${stderr.trim() || "empty"}`,
        ),
      );
    }, timeoutMs);

    child.on("error", (error: Error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(
        new Error(`cannot run lychee at ${binaryPath}: ${error.message}`, {
          cause: error,
        }),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, code });
    });

    // EPIPE if the child died before reading its input; the `close` handler above then
    // reports the exit code, which is the useful half. Swallowing it here without that
    // would be a `catch` that continues, so the write error is deliberately dropped only
    // because a louder one is already on its way.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
