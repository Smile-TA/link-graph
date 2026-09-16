/**
 * One pool for the process (PRD §9's "one data layer"). Astro's SSR pages call
 * `runReportCommand`/`listSites` directly rather than over HTTP — `packages/api`
 * exists but nothing runs it as a standalone process yet, and a second network hop to
 * a server this same process could import would only add a place for the two to
 * disagree about the site's report.
 */
import { createPool, databaseUrl } from "@link-graph/db";

export const pool = createPool(databaseUrl());
