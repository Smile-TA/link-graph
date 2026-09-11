/**
 * The curation overlay (PRD §3): a small, checked-in file supplying what the raw repo
 * cannot — `enabled`, `ignorePaths`, crawler mode, a rate override — keyed by the app
 * directory name (`sites.site_id`).
 *
 * **Why a file rather than a database table.** The overlay is a human decision about
 * which of 195 app directories are real, crawlable sites — "variant directory",
 * "platform utility", "no hostname" — and PRD §3 calls that curation, not derivation.
 * Checked in beside the code it feeds means the decision is reviewed the way the parser
 * is, in a diff, rather than mutated out-of-band in a table this package's tests cannot
 * see.
 *
 * `generated 2026-09-11 from a real clone (see registry.int.test.ts)`: every app that
 * had zero `hostname` values under `envs/prod/values.yaml` is `excluded: true` here,
 * split into "variant directory" (`-v2`, `-2025`/`-2026`, `-traefik-canary` suffixes)
 * and "platform utility" (backup/restore/vault/wordfence tooling) by name, and a plain
 * "no prod hostname" catch-all otherwise. It is 36 entries, not the PRD's 33 — the
 * estate has moved since that count was taken (2026-08-18), which is exactly the drift
 * this file exists to absorb without a code change.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface CurationEntry {
  /** `false` hides the app entirely — never reaches `upsertSite` (PRD §3). */
  readonly excluded?: boolean;
  /** Why, for a human reading the file — not read by the merge logic. */
  readonly reason?: string;
  /** Overrides the "has at least one prod host" default. */
  readonly enabled?: boolean;
  readonly ignorePaths?: readonly string[];
  readonly crawlerMode?: "http" | "playwright";
  readonly rateLimit?: number;
}

export type Curation = Readonly<Record<string, CurationEntry>>;

const CURATION_PATH = fileURLToPath(new URL("./curation.json", import.meta.url));

export async function loadCuration(): Promise<Curation> {
  const text = await readFile(CURATION_PATH, "utf8");
  return JSON.parse(text) as Curation;
}
