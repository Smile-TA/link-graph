/**
 * The clone adapter (implementation plan, step 9 / PRD §3): a shallow, read-only clone
 * of `deployment-configurations` into a temp directory, with the git SHA stamped so a
 * later "what did the registry know when" question has an answer.
 *
 * A real `git clone --depth=1` subprocess, not a library, because this is the one
 * external write link-graph never performs and a subprocess is the same boundary
 * `packages/linkcheck` drew around lychee (step 8): the tool is vendored/invoked, not
 * reimplemented. `deployment-configurations` is platform/GitOps owned and READ ONLY —
 * this package only ever clones and reads.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEPLOYMENT_CONFIGURATIONS_URL =
  "https://github.com/img-source/deployment-configurations";

export interface ClonedRepo {
  /** Absolute path to the checked-out working tree. */
  readonly dir: string;
  /** The commit the clone landed on — PRD §3's "git SHA stamped on each crawl". */
  readonly sha: string;
}

/** Injectable so unit tests never spawn git or touch the network. */
export interface CloneDeps {
  clone(url: string): Promise<ClonedRepo>;
  cleanup(dir: string): Promise<void>;
}

/**
 * The real adapter: `git clone --depth=1` into a fresh `mkdtemp` directory, then
 * `git rev-parse HEAD` for the SHA a shallow clone still carries on its one commit.
 */
export function createGitCloneDeps(): CloneDeps {
  return {
    async clone(url: string): Promise<ClonedRepo> {
      const dir = await mkdtemp(join(tmpdir(), "link-graph-registry-"));
      await execFileAsync("git", ["clone", "--depth=1", url, dir]);
      const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD"]);
      return { dir, sha: stdout.trim() };
    },
    async cleanup(dir: string): Promise<void> {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Clone, run `use`, then always clean up — so a caller gets the parsed registry, not a
 * directory it has to remember to delete. `use` receives the SHA alongside the path
 * because everything downstream (curation merge, `sites` rows) wants both.
 */
export async function withClone<T>(
  deps: CloneDeps,
  use: (repo: ClonedRepo) => Promise<T>,
): Promise<T> {
  const repo = await deps.clone(DEPLOYMENT_CONFIGURATIONS_URL);
  try {
    return await use(repo);
  } finally {
    await deps.cleanup(repo.dir);
  }
}
