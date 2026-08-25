/**
 * The one place a connection is created, and the one place pg is configured.
 */
import { Pool, types } from "pg";
import type { QueryResult, QueryResultRow } from "pg";

// int8 arrives as a string by default, because a 64-bit integer does not always fit
// in a double. Every bigint in this schema is an identity column or a count(*), so
// 2^53 rows would have to exist for that to matter; carrying ids around as strings
// costs more than that risk is worth.
types.setTypeParser(types.builtins.INT8, Number);

/**
 * Anything a query can be run against. Repository functions take this rather than a
 * `Pool` so that the same function works inside a transaction (`loadFixture` needs
 * exactly that — see fixture.ts).
 */
export interface Queryable {
  query<R extends QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * A mutation that must have matched exactly one row, or the caller's assumption about
 * the row's state was wrong.
 *
 * Written once because the four single-row mutations that use it — closing, reopening
 * and ticking a crawl or a frontier entry — all mean the same thing by a mismatch:
 * something else changed the row first. `context` says which row and what was expected,
 * since "matched 0 rows" alone tells an operator nothing.
 */
export function expectOneRow(rowCount: number | null, context: string): void {
  if (rowCount === 1) return;
  throw new Error(`${context} (matched ${String(rowCount)} rows)`);
}

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

/**
 * Run `body` inside a transaction, committing on return and rolling back on throw.
 *
 * A partial write is the failure mode engineering guide §1 is about: half a crawl in
 * the tables reads exactly like a small site.
 */
export async function withTransaction<T>(
  pool: Pool,
  body: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let unusable = false;
  try {
    await client.query("BEGIN");
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // The usual reason a write failed is that the connection is gone, and then the
    // ROLLBACK fails too. Awaiting it unguarded would replace the diagnosis with
    // "Client has encountered a connection error" and throw the real cause away, so
    // the original error is always what propagates.
    try {
      await client.query("ROLLBACK");
    } catch {
      unusable = true;
    }
    throw error;
  } finally {
    // Destroy rather than reuse a client whose transaction could not be closed:
    // returning it to the pool would land someone else's writes inside it.
    client.release(unusable);
  }
}
