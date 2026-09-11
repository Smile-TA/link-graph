/**
 * A real shallow clone of `deployment-configurations` — the one test in this package
 * that touches the network (implementation plan step 9, matching `packages/truth`'s
 * `resolve.int.test.ts`). `deployment-configurations` is confirmed reachable via
 * `git ls-remote`.
 *
 * The assertions are structural, not a page/app count: publishing a new app in the
 * real repo must not fail this test. What is pinned instead is the shape PRD §3 and
 * step 9 depend on — a real SHA, an `apps/` directory with well over a hundred entries,
 * and at least one real `envs/prod/values.yaml` carrying a hostname.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createGitCloneDeps, withClone } from "./clone.js";
import { extractHostnames } from "./derive.js";
import { parse as parseYaml } from "yaml";

const deps = createGitCloneDeps();
const cleanups: string[] = [];
afterAll(async () => {
  for (const dir of cleanups) await deps.cleanup(dir);
});

describe("createGitCloneDeps against the live estate", () => {
  it("clones deployment-configurations shallow, with a real SHA and a real apps/ tree", async () => {
    const result = await withClone(deps, async (repo) => {
      // SHA looks like a git commit hash, not a placeholder.
      expect(repo.sha).toMatch(/^[0-9a-f]{40}$/);

      const appDirs = (
        await import("node:fs/promises").then((fs) =>
          fs.readdir(join(repo.dir, "apps"), { withFileTypes: true }),
        )
      ).filter((e) => e.isDirectory());
      // Measured 2026-09-11: 199 app directories. Asserted as a floor — PRD §3 says
      // "33 apps with no hostname" out of a total that has grown since — so adding an
      // app is not a test failure.
      expect(appDirs.length).toBeGreaterThan(100);

      let withProdHostname = 0;
      for (const entry of appDirs) {
        const path = join(repo.dir, "apps", entry.name, "envs", "prod", "values.yaml");
        const text = await readFile(path, "utf8").catch(() => null);
        if (text === null) continue;
        if (extractHostnames(parseYaml(text)).length > 0) withProdHostname += 1;
      }
      // Measured 2026-09-11: 163 of 195 prod values files carry at least one
      // hostname. Asserted as a floor for the same reason as above.
      expect(withProdHostname).toBeGreaterThan(100);
      return { dir: repo.dir };
    });
    // `withClone` already cleaned up by the time this runs — nothing left to remove,
    // but record it anyway in case a future edit changes that contract.
    cleanups.push(result.dir);
  }, 30_000);
});
