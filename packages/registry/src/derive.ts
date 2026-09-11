/**
 * Derive the raw registry from a cloned `deployment-configurations` checkout (PRD §3):
 * every `apps/<app>/envs/{prod,stage}/values.yaml`, parsed for
 * `ingress.entries[].hosts[].hostname` and `image.tag`.
 *
 * Pure and filesystem-only — no network, no git — so it is unit-testable against
 * checked-in fixture YAML (packages/truth's pattern) without a clone.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface DerivedSite {
  /** The app directory name — the registry slug (`sites.site_id`). */
  readonly appDir: string;
  /** Hostnames from `envs/prod/values.yaml`'s `ingress.entries`, in file order. */
  readonly prodHosts: readonly string[];
  /** Same, for `envs/stage`. Empty when the app has no stage values file. */
  readonly stageHosts: readonly string[];
  /** `image.tag` from the prod values file, `null` when absent. */
  readonly deployedTag: string | null;
}

/** Injectable filesystem seam — unit tests read fixture strings, not real files. */
export interface DeriveDeps {
  listAppDirs(root: string): Promise<string[]>;
  readValuesFile(path: string): Promise<string | null>;
}

export function createFsDeriveDeps(): DeriveDeps {
  return {
    async listAppDirs(root: string): Promise<string[]> {
      const entries = await readdir(join(root, "apps"), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    },
    async readValuesFile(path: string): Promise<string | null> {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}

/**
 * `ingress.entries[].hosts[].hostname`, in document order. Returns `[]` rather than
 * throwing on the shapes real apps actually use — `ingress.enabled: false` (the
 * `integrity.com` root app, superseded by a dated variant) and the `-traefik-canary`
 * variants, whose values file has no `ingress` key at all — so those apps are
 * "derived, zero hosts" rather than a parse failure the whole sync aborts on.
 */
export function extractHostnames(values: unknown): string[] {
  if (values === null || typeof values !== "object") return [];
  const ingress = (values as Record<string, unknown>)["ingress"];
  if (ingress === null || typeof ingress !== "object") return [];
  const entries = (ingress as Record<string, unknown>)["entries"];
  if (!Array.isArray(entries)) return [];
  const hostnames: string[] = [];
  for (const entry of entries as unknown[]) {
    if (entry === null || typeof entry !== "object") continue;
    const hosts = (entry as Record<string, unknown>)["hosts"];
    if (!Array.isArray(hosts)) continue;
    for (const host of hosts as unknown[]) {
      if (host === null || typeof host !== "object") continue;
      const hostname = (host as Record<string, unknown>)["hostname"];
      if (typeof hostname === "string" && hostname.trim() !== "") {
        hostnames.push(hostname);
      }
    }
  }
  return hostnames;
}

/** `image.tag`, or `null` when the values file has none. */
export function extractImageTag(values: unknown): string | null {
  if (values === null || typeof values !== "object") return null;
  const image = (values as Record<string, unknown>)["image"];
  if (image === null || typeof image !== "object") return null;
  const tag = (image as Record<string, unknown>)["tag"];
  return typeof tag === "string" ? tag : null;
}

async function deriveOne(
  deps: DeriveDeps,
  root: string,
  appDir: string,
): Promise<DerivedSite> {
  const prodText = await deps.readValuesFile(
    join(root, "apps", appDir, "envs", "prod", "values.yaml"),
  );
  const stageText = await deps.readValuesFile(
    join(root, "apps", appDir, "envs", "stage", "values.yaml"),
  );
  const prodValues: unknown = prodText === null ? null : parseYaml(prodText);
  const stageValues: unknown = stageText === null ? null : parseYaml(stageText);
  return {
    appDir,
    prodHosts: extractHostnames(prodValues),
    stageHosts: extractHostnames(stageValues),
    deployedTag: extractImageTag(prodValues),
  };
}

/**
 * Every app directory in the clone, derived independently — one app's malformed YAML
 * must not blank the other 194 (engineering guide §1: a partial registry read as the
 * whole registry is the same failure mode as a partial crawl read as the whole site).
 */
export async function deriveSites(
  deps: DeriveDeps,
  root: string,
): Promise<DerivedSite[]> {
  const appDirs = await deps.listAppDirs(root);
  const sites: DerivedSite[] = [];
  for (const appDir of appDirs.sort()) {
    sites.push(await deriveOne(deps, root, appDir));
  }
  return sites;
}
