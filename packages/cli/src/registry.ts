/**
 * The registry lookup all three commands start with.
 *
 * One home, because the refusal is the same fact each time — the site is not in the
 * registry, the remedy is in the registry, nothing was crawled — and because the message
 * has to name step 9, which is what populates the table. `crawl` adds a second refusal
 * of its own (a disabled site), and `note`/`report` deliberately do not: they read a
 * crawl that already happened, and a site the platform has stopped serving still has
 * findings somebody may want to judge.
 */
import { findSiteBySlug, type Queryable, type SiteRow } from "@link-graph/db";
import { UsageError } from "./exit.js";

export async function siteBySlug(db: Queryable, siteId: string): Promise<SiteRow> {
  const site = await findSiteBySlug(db, siteId);
  if (site === null) {
    throw new UsageError(
      `no site ${JSON.stringify(siteId)} in the registry. Nothing populates the sites ` +
        `table yet — step 9 of docs/03-implementation-plan.md derives it from ` +
        `deployment-configurations — so until then a row is inserted with upsertSite ` +
        `from @link-graph/db`,
    );
  }
  return site;
}
