/**
 * The registry package's seam (step 9, PRD §3/§3.1): sync the estate from
 * `deployment-configurations` into `sites` + `registry_health`, and report the drift
 * between what is deployed and what is monitored.
 */
export { syncRegistry } from "./sync.js";
export type { SyncDeps, SyncResult } from "./sync.js";
export { registryDriftReport, formatDriftReport } from "./report.js";
export { createGitCloneDeps, withClone, DEPLOYMENT_CONFIGURATIONS_URL } from "./clone.js";
export type { CloneDeps, ClonedRepo } from "./clone.js";
export {
  createFsDeriveDeps,
  deriveSites,
  extractHostnames,
  extractImageTag,
} from "./derive.js";
export type { DeriveDeps, DerivedSite } from "./derive.js";
export { loadCuration } from "./curation.js";
export type { Curation, CurationEntry } from "./curation.js";
export { mergeRegistry, mergeSite } from "./merge.js";
export { probeLiveness, hasPlatformSignature } from "./liveness.js";
export type {
  DnsResult,
  HttpProbeResult,
  LivenessDeps,
  LivenessResult,
} from "./liveness.js";
export { createProbeDeps } from "./probe-adapter.js";
export { classifyDrift } from "./drift.js";
export type { CoverageDrift, DriftProbe, DriftSite } from "./drift.js";
