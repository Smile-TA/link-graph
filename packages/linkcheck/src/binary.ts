/**
 * Where the checker is, and what happens when it is not there.
 *
 * **A link checker that cannot find its binary and reports zero broken links is
 * engineering guide §1's opening bug with a different executable missing.** So the
 * location is injected rather than hardcoded, and an absent binary is a refusal that
 * names the path, the release this code was written against, and the command that
 * produces it — never a run that quietly checks nothing.
 *
 * **The binary is deliberately not in git.** lychee ships as a 17.9 MB Mach-O / ELF
 * executable and a multi-megabyte third-party binary in git history is effectively
 * irreversible, so `scripts/fetch-lychee.sh` downloads it into the gitignored `vendor/`
 * directory against the release's published sha256. PRD §8 says the binary is vendored
 * into the *worker image*, which the same script serves from a Dockerfile; whether it
 * also lands in the repository is a decision for a human, and until it is made this file
 * is the only thing that has to change.
 */
import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The release every measurement in this package was made against (2026-09-02).
 *
 * Not enforced at run time — refusing to run against 0.24.3 would be a rule about a
 * version nobody has tested either way — but recorded here and quoted in the refusal
 * below, because the JSON shape `report.ts` parses and the flags `lychee.ts` passes are
 * both this release's.
 */
export const LYCHEE_RELEASE = "lychee-v0.24.2";

/**
 * `<repo>/vendor/lychee/lychee`. Resolved from this module's own URL rather than from
 * `process.cwd()`: a worker started from anywhere must find the same binary, and a
 * cwd-relative default would silently miss it and — before this file existed — check
 * nothing.
 */
export const VENDORED_LYCHEE = fileURLToPath(
  new URL("../../../vendor/lychee/lychee", import.meta.url),
);

export interface BinaryDeps {
  /** Injected so the refusal is unit-testable without a filesystem. */
  isExecutable(path: string): boolean;
}

const realDeps: BinaryDeps = {
  isExecutable(path: string): boolean {
    try {
      // X_OK rather than F_OK: a downloaded tarball extracted without the mode bit is a
      // file that exists and cannot be spawned, and `spawn` would then fail with EACCES
      // deep inside a run rather than here.
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * The lychee binary to run: `LYCHEE_BIN` if set, otherwise the vendored location.
 *
 * @throws if the resolved path is not an executable file.
 */
export function resolveLycheeBinary(
  env: Readonly<Record<string, string | undefined>>,
  deps: BinaryDeps = realDeps,
): string {
  const override = env["LYCHEE_BIN"]?.trim();
  // An empty LYCHEE_BIN is what an unset variable looks like in a Compose file, and
  // spawning "" fails with a message about the empty string rather than about lychee.
  const path = override === undefined || override === "" ? VENDORED_LYCHEE : override;
  if (deps.isExecutable(path)) return path;
  throw new Error(
    `no executable lychee at ${path}${override === undefined || override === "" ? "" : " (from LYCHEE_BIN)"}. ` +
      `External link checking needs the ${LYCHEE_RELEASE} binary: run ` +
      `\`scripts/fetch-lychee.sh\`, which downloads it into vendor/ and verifies the ` +
      `release's published sha256, or set LYCHEE_BIN to a copy you already have. ` +
      `Refusing rather than skipping: a checker that found no binary and reported no ` +
      `broken links would read as good news.`,
  );
}
