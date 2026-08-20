/**
 * `external_urls` — external link status, keyed by URL and shared across every site
 * (PRD §6.1). The TTL policy reads `lastChecked`; this table, not lychee's cache, is
 * the source of truth.
 */
import type { Queryable } from "../pool.js";

export interface ExternalUrlInput {
  readonly urlNormalized: string;
  /** `null` = never checked. Must not be read as "checked long ago and fine". */
  readonly lastChecked: Date | null;
  readonly statusCode: number | null;
  /** A host that blocks us (429/403) is unverified, never broken. */
  readonly unverified: boolean;
}

const COLUMNS = `url_normalized AS "urlNormalized", last_checked AS "lastChecked",
  status_code AS "statusCode", unverified`;

export async function upsertExternalUrl(
  db: Queryable,
  url: ExternalUrlInput,
): Promise<void> {
  await db.query(
    `INSERT INTO external_urls (url_normalized, last_checked, status_code, unverified)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (url_normalized) DO UPDATE SET
       last_checked = excluded.last_checked, status_code = excluded.status_code,
       unverified = excluded.unverified`,
    [url.urlNormalized, url.lastChecked, url.statusCode, url.unverified],
  );
}

export async function findExternalUrl(
  db: Queryable,
  urlNormalized: string,
): Promise<ExternalUrlInput | null> {
  const { rows } = await db.query<ExternalUrlInput>(
    `SELECT ${COLUMNS} FROM external_urls WHERE url_normalized = $1`,
    [urlNormalized],
  );
  return rows[0] ?? null;
}
