/**
 * The library surface, separate from `bin.ts`. `bin.ts` has top-level `await` and
 * writes to `process.stdout` the moment it is loaded, so it cannot be `main`
 * (Node's default entry point) without every importer of this package running a CLI
 * invocation as a side effect. `package.json` has no `main`/`exports` field, so this
 * file — `index.ts` — is what Node resolves by convention, and `bin.ts` stays reachable
 * only through the `bin` field.
 *
 * The one export needed outside this package so far: step 10's scheduler runs the
 * same crawl-then-analyse pipeline this CLI runs, against the same registry row, and
 * must not re-derive it.
 */
export { runCrawlCommand } from "./run.js";
export type { CrawlCommandDeps } from "./run.js";
export type { CrawlReport } from "./report.js";
