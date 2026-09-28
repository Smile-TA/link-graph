/** `registry_health` — one row per liveness probe (PRD §3.1). */
import type { Queryable } from "../pool.js";

export interface RegistryHealthInput {
  /** The surrogate `sites.id`, not the registry slug. */
  readonly siteId: number;
  readonly checkedAt: Date;
  readonly dnsOk: boolean;
  readonly serves: boolean;
  readonly platformSig: boolean;
  readonly versionTxt: string | null;
  /** Non-null when this probe's root request redirected to a different host. */
  readonly redirectsToHost: string | null;
}

const COLUMNS = `site_id AS "siteId", checked_at AS "checkedAt", dns_ok AS "dnsOk",
  serves, platform_sig AS "platformSig", version_txt AS "versionTxt",
  redirects_to_host AS "redirectsToHost"`;

export async function insertRegistryHealth(
  db: Queryable,
  probe: RegistryHealthInput,
): Promise<void> {
  await db.query(
    `INSERT INTO registry_health
       (site_id, checked_at, dns_ok, serves, platform_sig, version_txt, redirects_to_host)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      probe.siteId,
      probe.checkedAt,
      probe.dnsOk,
      probe.serves,
      probe.platformSig,
      probe.versionTxt,
      probe.redirectsToHost,
    ],
  );
}

/** Newest probe first. */
export async function listRegistryHealth(
  db: Queryable,
  siteId: number,
): Promise<RegistryHealthInput[]> {
  const { rows } = await db.query<RegistryHealthInput>(
    `SELECT ${COLUMNS} FROM registry_health WHERE site_id = $1
     ORDER BY checked_at DESC`,
    [siteId],
  );
  return rows;
}

/**
 * The newest `registry_health` row per site, across the whole registry in one query —
 * `DISTINCT ON` rather than `listRegistryHealth` called once per site, so the
 * coverage-drift report (step 9) makes one round trip instead of one per site.
 */
export async function listLatestRegistryHealth(
  db: Queryable,
): Promise<RegistryHealthInput[]> {
  const { rows } = await db.query<RegistryHealthInput>(
    `SELECT DISTINCT ON (site_id) ${COLUMNS}
     FROM registry_health
     ORDER BY site_id, checked_at DESC`,
  );
  return rows;
}
