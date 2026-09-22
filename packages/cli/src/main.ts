/**
 * The command's shell: argv in, an exit code out, and the only place that knows about
 * stdout and stderr.
 *
 * **stdout is the report and nothing else.** Progress and every failure go to stderr, so
 * `link-graph crawl <site-id> > orphans.txt` produces a file that is either the whole
 * report or empty — never half of one. On any failing path stdout stays untouched, which
 * is engineering guide §1 applied to a pipe: a truncated table is a smaller site.
 *
 * It returns the exit code rather than calling `process.exit`, so that the integration
 * tier can run the whole command — argv, pool, crawl, report, code — and read what a
 * person would have seen. `bin.ts` is the four lines that turn it into a process.
 */
import { createPool, databaseUrl } from "@link-graph/db";
import type { Pool } from "pg";
import { parseArgs } from "./args.js";
import {
  EXIT,
  UsageError,
  exitCodeForFailure,
  exitCodeForReport,
  exitCodeForSiteReport,
} from "./exit.js";
import { formatNoteOutcome, runNoteCommand } from "./note-command.js";
import {
  formatSyncOutcome,
  runRegistryReportCommand,
  runRegistrySyncCommand,
} from "./registry-command.js";
import { formatReport } from "./report.js";
import { runReportCommand } from "./report-command.js";
import { runCrawlCommand, type CrawlCommandDeps } from "./run.js";
import { formatSiteReport } from "./site-report.js";

export interface Io {
  /** The report. Written once, at the end, or not at all. */
  out(line: string): void;
  /** Progress and failures. */
  err(line: string): void;
  /** Where `DATABASE_URL` comes from. Defaults to the process environment. */
  readonly env?: NodeJS.ProcessEnv;
}

const USAGE = `link-graph — orphan and link analysis for the estate

Usage:
  link-graph crawl <site-id> [--stage]
                               resolve the site's truth source, crawl it, analyse it,
                               and print the orphan table. --stage crawls the site's
                               stage host instead of prod (step 14); its crawl never
                               counts as the site's report-worthy crawl (PRD §7.1)
  link-graph report <site-id>  re-read the site's last complete crawl and print its
                               findings split by review state. Reads the database only:
                               no network, no re-analysis, no number changed
  link-graph note <site-id> <kind> <subject> --intentional|--acknowledged -m <note>
                               [--by <who>]
                               record one judgement of one finding
  link-graph registry sync    clone deployment-configurations, derive the estate,
                               merge the curation overlay, upsert sites, probe
                               liveness (step 9)
  link-graph registry report  print the coverage-drift table: deployed but
                               unmonitored, and configured but dead
  link-graph --help

<kind> is orphan or broken_internal_link. <subject> is the page the finding is about —
a path or an absolute URL — which for a broken link is its target, not the pages linking
to it.

Reviewing a finding does not hide it and does not change a count: a report where every
orphan has been judged reads "538 orphans, 538 reviewed" (PRD §7.1). --intentional means
unlinked by design; --acknowledged means a real defect, seen, not fixed yet. There is no
"fixed" state — a fixed orphan gains an inbound link and the next crawl stops reporting
it. --by defaults to $USER.

Installed as a workspace binary. The two invocations verified in a fresh checkout are
  npx link-graph crawl <site-id>
  npm run link-graph -- crawl <site-id>
A bare "link-graph" additionally needs tsx on PATH.

<site-id> is a sites.site_id slug. \`link-graph registry sync\` populates that table
from deployment-configurations (step 9).

The database is DATABASE_URL, defaulting to the local docker-compose Postgres.

Exit codes:
  0  crawl:  the orphan question was answered — the table printed is the whole site
     report: the stored crawl has an orphan count. It does NOT mean the inventory that
             count was taken against was whole: whether a truth source went unread is
             computed per run and stored nowhere, so a crawl that exited 3 for a short
             inventory is re-read as a 0 here (PRD §15). The report says so in words
     note:   the review was written
  1  usage, registry or configuration error; nothing was crawled or written
  2  the run failed and printed no numbers: a partial crawl, an analysis that refused
     this crawl, a crawl the analysis never finished, an unreachable or unmigrated
     database, or a bug. The message says which
  3  the crawl finished and the orphan count is unknown: the site has no truth source,
     or the crawl was a sample. A coverage gap, never zero orphans`;

/**
 * `deps` is the same injection seam `crawl()` and `resolveTruthSource()` expose, and it
 * is here for the same reason: the integration tier has to exercise this command whole,
 * and the only alternative — pointing it at a live host — earns an hour-long Wordfence
 * ban on the first 503 (PRD §5.1). Production passes nothing.
 */
export interface CommandDeps extends CrawlCommandDeps {
  /**
   * Injected because two of the three commands print or store a time: a review's
   * `reviewed_at`, and the age printed beside every review and every crawl. A test that
   * asserts on "13 day(s) ago" cannot read the wall clock (engineering guide §4.4).
   */
  readonly now: () => Date;
}

export async function main(
  argv: readonly string[],
  io: Io,
  deps: Partial<CommandDeps> = {},
): Promise<number> {
  const invocation = parseArgs(argv);
  if (invocation.kind === "help") {
    io.out(USAGE);
    return EXIT.ok;
  }
  if (invocation.kind === "usage-error") {
    io.err(`link-graph: ${invocation.problem}`);
    return EXIT.usage;
  }

  let pool: Pool | null = null;
  try {
    pool = connect(io.env, io);
    const now = deps.now ?? (() => new Date());
    if (invocation.kind === "report") {
      const report = await runReportCommand(pool, invocation.siteId);
      io.out(formatSiteReport(report, now()));
      return exitCodeForSiteReport(report);
    }
    if (invocation.kind === "registry-sync") {
      const outcome = await runRegistrySyncCommand(pool);
      io.out(formatSyncOutcome(outcome));
      return EXIT.ok;
    }
    if (invocation.kind === "registry-report") {
      io.out(await runRegistryReportCommand(pool));
      return EXIT.ok;
    }
    if (invocation.kind === "note") {
      const outcome = await runNoteCommand(
        pool,
        {
          siteId: invocation.siteId,
          finding: invocation.finding,
          subject: invocation.subject,
          state: invocation.state,
          note: invocation.note,
          reviewedBy: reviewer(invocation.by, io.env),
        },
        now(),
      );
      io.out(formatNoteOutcome(outcome));
      return EXIT.ok;
    }
    // Progress is not part of `deps`: it is by definition what the operator sees, and
    // this is the only file that knows where that is.
    const report = await runCrawlCommand(
      pool,
      invocation.siteId,
      (line) => io.err(line),
      deps,
      invocation.env,
    );
    io.out(formatReport(report));
    return exitCodeForReport(report);
  } catch (error) {
    printError(io, error);
    return exitCodeForFailure(error);
  } finally {
    // Reported, never thrown: the exit code is already decided by then, and a pool that
    // cannot close after a report has been printed must not replace a real verdict with
    // "nothing was crawled".
    if (pool !== null) {
      await pool.end().catch((error: unknown) => printError(io, error));
    }
  }
}

/**
 * Who is judging: `--by`, or `$USER`. No auth in phase 1 (PRD §7.1), and no anonymous
 * fallback — a review nobody signed is one nobody can ask about, so an unset `$USER`
 * with no `--by` is a refusal rather than a row saying "unknown".
 */
function reviewer(by: string | null, env: NodeJS.ProcessEnv | undefined): string {
  if (by !== null) return by;
  const user = (env ?? process.env)["USER"];
  if (user === undefined || user.trim() === "") {
    throw new UsageError(
      `no --by given and $USER is not set, so this review would have no author. ` +
        `Reviews are attributed to a person, not to a process`,
    );
  }
  return user;
}

/** A `DATABASE_URL` that cannot be used is a usage error: nothing was crawled. */
function connect(env: NodeJS.ProcessEnv | undefined, io: Io): Pool {
  let pool: Pool;
  try {
    pool = createPool(databaseUrl(env ?? process.env));
  } catch (error) {
    throw new UsageError(describeError(error));
  }
  // Without a listener, pg re-emits an *idle* client's error as an uncaught `error`
  // event and Node exits 1 — the code this command documents as "nothing was crawled" —
  // from a Postgres restart during the long gaps between requests of a 33-minute crawl.
  // Step 3 flagged the missing handler and deferred it to step 10's worker; this is the
  // one process with an exit code to get wrong in the meantime.
  //
  // **It does not cover a client that is checked out.** `pg-pool` removes this listener
  // on acquire and `pg`'s client emits `error` on itself even with a query in flight, so
  // a connection lost inside `writePage`'s or `analyse`'s transaction still dies with an
  // unhandled `error` event and exit 1. Closing that needs a listener where the client
  // is checked out — `withTransaction` in packages/db — which is step 3's committed code
  // and step 10's concern. Reported rather than papered over here.
  pool.on("error", (error) => printError(io, error));
  return pool;
}

/** One prefix for everything the operator reads on stderr. */
const printError = (io: Io, error: unknown): void =>
  io.err(`link-graph: ${describeError(error)}`);

/**
 * Every deliberate throw in this project carries a sentence naming the site, the crawl
 * and the remedy (engineering guide §6), so the message is the diagnosis and a stack
 * would bury it — but two error shapes have no message worth printing on their own.
 *
 * **`AggregateError` is the ordinary case, not an exotic one, and it prints empty.**
 * `localhost` is dual-stack, so a refused connection to the default `DATABASE_URL`
 * arrives as an `AggregateError` whose own `message` is `""` and whose two `errors` hold
 * `connect ECONNREFUSED ::1:5432` and `connect ECONNREFUSED 127.0.0.1:5432`. Measured
 * 2026-08-24 with the port wrong: without this branch the whole diagnosis was
 * `link-graph: ` and an exit code. `packages/db/src/testing/temp-database.ts` records the
 * same measurement and has the same three lines; a second copy rather than a shared one
 * because that one is a test helper inside another package, and the duplication is named
 * here rather than lifted (see the note on step 6's three duplications).
 *
 * `cause` is walked because `new Error(msg, { cause })` is how this codebase wraps —
 * `createTempDatabase` does exactly that — and because nothing else would print it.
 */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    const parts = (error.errors as unknown[]).map(describeError).filter((p) => p !== "");
    return error.message !== ""
      ? `${error.message}: ${parts.join("; ")}`
      : parts.join("; ");
  }
  if (!(error instanceof Error)) return String(error);
  const detail =
    error.cause === undefined || error.cause === null
      ? ""
      : `: ${describeError(error.cause)}`;
  // An Error with no message of its own — pg raises a few — would otherwise print as a
  // bare prefix, which is a failure with the diagnosis missing.
  return `${error.message !== "" ? error.message : error.name}${detail}`;
}
