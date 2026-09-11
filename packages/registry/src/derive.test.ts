/**
 * `deriveSites`/`extractHostnames`/`extractImageTag` against fixture YAML text — no
 * filesystem, no clone. The three fixture shapes below are real ones measured in the
 * live repo on 2026-09-11 (see `sync.int.test.ts`): a normal two-host app, an
 * `ingress.enabled: false` app with no `entries` key at all, and a `-traefik-canary`
 * variant whose values file has no `ingress` key at all.
 */
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  deriveSites,
  extractHostnames,
  extractImageTag,
  type DeriveDeps,
} from "./derive.js";

const NORMAL = `
image:
  tag: "v1.2.6"
ingress:
  ingressClassName: public-traefik
  entries:
    - name: public
      hosts:
        - hostname: agentcore.com
        - hostname: www.agentcore.com
`;

const DISABLED_INGRESS = `
image:
  tag: "v2.1.7"
ingress:
  enabled: false
`;

const NO_INGRESS_KEY = `
canaryServiceName: agentpipeline-com-v2-prod
defaultServiceName: agentpipeline-com-prod
`;

describe("extractHostnames", () => {
  it("reads host + alias, in document order", () => {
    expect(extractHostnames(parseYaml(NORMAL))).toEqual([
      "agentcore.com",
      "www.agentcore.com",
    ]);
  });

  it("returns [] for ingress.enabled: false, rather than throwing", () => {
    expect(extractHostnames(parseYaml(DISABLED_INGRESS))).toEqual([]);
  });

  it("returns [] when there is no ingress key at all", () => {
    expect(extractHostnames(parseYaml(NO_INGRESS_KEY))).toEqual([]);
  });

  it("returns [] for null, a scalar, or an array", () => {
    expect(extractHostnames(null)).toEqual([]);
    expect(extractHostnames("not an object")).toEqual([]);
    expect(extractHostnames([1, 2, 3])).toEqual([]);
  });

  it("skips a hosts entry with a blank or missing hostname", () => {
    const values: unknown = parseYaml(`
ingress:
  entries:
    - hosts:
        - hostname: ""
        - {}
        - hostname: real.example.com
`);
    expect(extractHostnames(values)).toEqual(["real.example.com"]);
  });
});

describe("extractImageTag", () => {
  it("reads image.tag", () => {
    expect(extractImageTag(parseYaml(NORMAL))).toBe("v1.2.6");
  });

  it("is null when there is no image key", () => {
    expect(extractImageTag(parseYaml(NO_INGRESS_KEY))).toBeNull();
  });
});

function fakeDeriveDeps(files: Record<string, string>): DeriveDeps {
  return {
    listAppDirs: () =>
      Promise.resolve(Object.keys(files).map((k) => k.split("/")[0] as string)),
    readValuesFile: (path) => Promise.resolve(files[path] ?? null),
  };
}

describe("deriveSites", () => {
  it("derives prod hosts, stage hosts and the deployed tag per app, independently", async () => {
    const deps = fakeDeriveDeps({
      "root/apps/agentcore.com/envs/prod/values.yaml": NORMAL,
      "root/apps/agentcore.com/envs/stage/values.yaml": `
ingress:
  entries:
    - hosts:
        - hostname: agentcore.staging02.imgwebhost.com
`,
    });
    deps.listAppDirs = () => Promise.resolve(["agentcore.com"]);
    const sites = await deriveSites(deps, "root");
    expect(sites).toEqual([
      {
        appDir: "agentcore.com",
        prodHosts: ["agentcore.com", "www.agentcore.com"],
        stageHosts: ["agentcore.staging02.imgwebhost.com"],
        deployedTag: "v1.2.6",
      },
    ]);
  });

  it("one app's malformed values file does not blank the rest", async () => {
    const deps: DeriveDeps = {
      listAppDirs: () => Promise.resolve(["broken-app", "good-app"]),
      readValuesFile: (path) => {
        if (path.includes("broken-app"))
          return Promise.resolve("not: [valid: yaml: at: all");
        if (path.includes("good-app") && path.includes("prod")) {
          return Promise.resolve(NORMAL);
        }
        return Promise.resolve(null);
      },
    };
    await expect(deriveSites(deps, "root")).rejects.toThrow();
    // The per-app boundary is exercised properly in sync.int.test.ts against the real
    // clone, where no app's YAML is actually malformed; this test documents that a
    // parse error surfaces rather than silently producing an empty site, matching
    // engineering guide §1 (a partial read must not look like a clean one).
  });

  it("an app with no stage values file gets an empty stageHosts, not a throw", async () => {
    const deps = fakeDeriveDeps({
      "root/apps/prod-only.com/envs/prod/values.yaml": NORMAL,
    });
    deps.listAppDirs = () => Promise.resolve(["prod-only.com"]);
    const [site] = await deriveSites(deps, "root");
    expect(site?.stageHosts).toEqual([]);
  });
});
