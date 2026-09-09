export { checkExternalUrls, IncompleteLinkcheckError } from "./check.js";
export type { LinkcheckDeps, LinkcheckOptions, LinkcheckResult } from "./check.js";
export { LYCHEE_RELEASE, resolveLycheeBinary, VENDORED_LYCHEE } from "./binary.js";
export type { BinaryDeps } from "./binary.js";
export { createLycheeRunner } from "./lychee.js";
export type { LycheeOptions, LycheeRunner } from "./lychee.js";
export { parseLycheeReport, reconcile } from "./report.js";
export type { LinkResult, LycheeEntry, LycheeMap, LycheeReport } from "./report.js";
export { summariseResults } from "./summary.js";
export type { LinkcheckCounts } from "./summary.js";
export { externalUrlVerdict, isBrokenExternal, linkcheckVerdict } from "./verdict.js";
export type {
  ExternalUrlVerdict,
  LinkcheckProgress,
  LinkcheckVerdict,
  LinkOutcome,
} from "./verdict.js";
