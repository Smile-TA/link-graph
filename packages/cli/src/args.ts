/**
 * The command line, as a pure function. One command, one site (step 7): no queue, no
 * multi-site run, no options.
 *
 * **Every unrecognised word is a refusal rather than something ignored.** `crawl a b`
 * taking `a` and dropping `b` is how someone reads a report for one site believing it
 * covers two, and `--dry-run` swallowed as a site id is a crawl of a site called
 * `--dry-run`. There is no flag this command needs yet, so an option-shaped argument is
 * always a mistake, and saying so costs one line.
 */
export type Invocation =
  | { readonly kind: "crawl"; readonly siteId: string }
  | { readonly kind: "help" }
  | { readonly kind: "usage-error"; readonly problem: string };

const HINT = "usage: link-graph crawl <site-id> (see --help)";

export function parseArgs(argv: readonly string[]): Invocation {
  const [command, siteId, extra] = argv;
  // Help is the WHOLE invocation or nothing. Letting `--help` win from anywhere in argv
  // — or letting it swallow the words after it — means `link-graph $FLAGS crawl "$SITE"`
  // with a leftover flag prints usage and exits 0 having crawled nothing: a success code
  // for a run that did not happen, which is engineering guide §1 in the one signal a
  // cron job reads.
  if (command === "--help" || command === "-h" || command === "help") {
    return argv.length === 1
      ? { kind: "help" }
      : usageError(`${quote(command)} takes no other arguments`);
  }
  if (command === undefined) return usageError("no command given");
  if (command !== "crawl") return usageError(`unknown command ${quote(command)}`);
  if (siteId === undefined) return usageError("crawl needs a site id");
  if (siteId.startsWith("-")) {
    return usageError(`unknown option ${quote(siteId)} — this command takes no options`);
  }
  if (extra !== undefined) {
    return usageError(`unexpected argument ${quote(extra)} — crawl takes one site id`);
  }
  return { kind: "crawl", siteId };
}

const usageError = (problem: string): Invocation => ({
  kind: "usage-error",
  problem: `${problem}. ${HINT}`,
});

const quote = (value: string): string => JSON.stringify(value);
