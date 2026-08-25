#!/usr/bin/env tsx
/**
 * The process. Everything else in this package returns values, which is what lets the
 * integration tier run the whole command and read what a person would have seen; this
 * file is the four lines that cannot be tested that way.
 *
 * `process.exitCode` rather than `process.exit`: `exit` truncates pending stdout writes
 * when it is a pipe, which would cut the orphan table off mid-row.
 */
import { EXIT } from "./exit.js";
import { describeError, main } from "./main.js";

const io = {
  out: (line: string) => process.stdout.write(`${line}\n`),
  err: (line: string) => process.stderr.write(`${line}\n`),
};

// A reader that closes early — `link-graph crawl x | head` — makes the tail of a large
// table fail to flush, and an unhandled EPIPE on stdout is not a rejection of `main`:
// measured 2026-08-25 on Node 26, a 200 KB write past the pipe buffer prints
// `Unhandled 'error' event` with a stack trace *after* the verdict was decided and the
// process exits 1 — the code this command documents as "nothing was crawled". Under the
// buffer (2/20/70 KB) it exits cleanly, which is why this needs saying rather than
// testing by hand once. The verdict already in `process.exitCode` stands; anything that
// is not EPIPE is a stdout we could not write and is reported.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") io.err(`link-graph: stdout: ${describeError(error)}`);
});

// `main` is written not to throw, and this is here for when that stops being true: an
// unguarded top-level rejection discards the exit code `main` decided and Node exits 1.
try {
  process.exitCode = await main(process.argv.slice(2), io);
} catch (error) {
  io.err(`link-graph: ${describeError(error)}`);
  process.exitCode = EXIT.failed;
}
