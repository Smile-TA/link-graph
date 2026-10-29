/**
 * The seam step 6 and step 7 use: resolve one site's truth source, with the HTTP fetch
 * injectable. The parsers behind it (`rest.ts`, `sitemap.ts`, `inventory.ts`) stay
 * internal — they are this package's own shape, and exporting them would let a later
 * step couple to it before anything needs to.
 */
export { resolveTruthSource, TruthSourceUnresolvedError } from "./resolve.js";
export type {
  PostTypeInventory,
  ResolveOptions,
  TruthFinding,
  TruthFindingKind,
  TruthSite,
  TruthSourceKind,
  TruthSourceResult,
} from "./resolve.js";
export { createHttpFetcher } from "./http.js";
export type { HttpResponse, HttpResult, TruthDeps } from "./http.js";
export type { TruthCounts, TruthUrl } from "./inventory.js";
