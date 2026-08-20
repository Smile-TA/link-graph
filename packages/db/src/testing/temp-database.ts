/**
 * A throwaway database per integration test file.
 *
 * Why not one shared database with truncation: the migration test needs a genuinely
 * empty database to apply the whole set to, and vitest runs test files in parallel,
 * so a shared one would have two runners racing on `schema_migrations`.
 *
 * There is deliberately no "skip if Postgres is unreachable" path. A suite that goes
 * green because it could not find a database is engineering guide §1 exactly, and it
 * is the reason integration tests are their own command (`npm run test:integration`)
 * rather than something `npm test` tries and shrugs off.
 */
import type { Pool } from "pg";
import { databaseUrl } from "../config.js";
import { createPool } from "../pool.js";

/**
 * A database name cannot be a bind parameter, so it is interpolated into DDL — the
 * one place in this package that happens. The label is checked rather than trusted,
 * and kept short because Postgres identifiers are 63 bytes.
 */
const LABEL = /^[a-z][a-z0-9_]{0,20}$/;

let sequence = 0;

export interface TempDatabase {
  readonly pool: Pool;
  /** Closes the pool and drops the database. */
  drop(): Promise<void>;
}

export async function createTempDatabase(label: string): Promise<TempDatabase> {
  if (!LABEL.test(label)) {
    throw new Error(`temp database label must match ${LABEL.source}, got ${label}`);
  }
  const adminUrl = databaseUrl();
  const admin = createPool(adminUrl);
  // process.pid keeps two concurrent runs apart; the sequence keeps two files in one
  // run apart. Neither is asserted on, so neither needs to be deterministic.
  const name = `link_graph_test_${label}_${process.pid}_${sequence++}`;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (error) {
    await admin.end();
    throw new Error(
      `cannot create the test database at ${redact(adminUrl)}: ${detail(error)}. ` +
        `Integration tests need Postgres — run \`docker compose up -d\`.`,
      { cause: error },
    );
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  return {
    pool,
    async drop() {
      try {
        await pool.end();
        // WITH (FORCE) terminates leftover backends. Measured: without it, a
        // connection a failing test forgot to close makes DROP DATABASE wait ~5s and
        // then error with "is being accessed by other users".
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        // Always, or a failed drop leaves an open pool and vitest hangs on the
        // handle instead of reporting why the test failed.
        await admin.end();
      }
    },
  };
}

/**
 * pg reports a refused connection as an `AggregateError` whose own message is empty
 * (one error per resolved address), so the obvious `error.message` produces
 * "cannot create the test database: ." — a diagnostic with the diagnosis missing.
 */
function detail(error: unknown): string {
  if (error instanceof AggregateError) {
    return (error.errors as unknown[]).map(detail).join("; ");
  }
  if (error instanceof Error) return error.message !== "" ? error.message : error.name;
  return String(error);
}

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== "") parsed.password = "***";
    return parsed.toString();
  } catch {
    return url;
  }
}
