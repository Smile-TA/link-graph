/**
 * The registry lookup all three commands start with.
 *
 * One home, because the refusal is the same fact each time — the site is not in the
 * registry, the remedy is in the registry, nothing was crawled — and because the message
 * has to name `registry sync`, which is what populates the table. `crawl` adds a second
 * refusal of its own (a disabled site), and `note`/`report` deliberately do not: they
 * read a crawl that already happened, and a site the platform has stopped serving still
 * has findings somebody may want to judge.
 */
import { findSiteBySlug, type Queryable, type SiteRow } from "@link-graph/db";
import { UsageError } from "./exit.js";

export async function siteBySlug(db: Queryable, siteId: string): Promise<SiteRow> {
  const site = await findSiteBySlug(db, siteId);
  if (site === null) {
    throw new UsageError(
      `no site ${JSON.stringify(siteId)} in the registry. \`link-graph registry sync\` ` +
        `(step 9) derives the sites table from deployment-configurations — run it, or ` +
        `insert a row by hand with upsertSite from @link-graph/db`,
    );
  }
  return site;
}
