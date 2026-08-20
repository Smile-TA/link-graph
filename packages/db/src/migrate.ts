/**
 * Forward-only SQL migrations.
 *
 * Plain numbered `.sql` files and a 60-line runner, because the analysis in step 4 is
 * SQL — a recursive CTE and a set difference — and an ORM's migration DSL would
 * obscure the thing this schema exists to serve (implementation plan, step 3).
 *
 * Three rules, each of them an engineering guide §1 case:
 *
 * - **One transaction per file.** Postgres runs DDL transactionally, so a file that
 *   fails partway leaves nothing behind and is not recorded as applied. A
 *   half-applied schema that reported success is the worst outcome available here.
 * - **Applied files are immutable, and the checksum proves it.** Editing a migration
 *   that has already run makes two databases with the same recorded history and
 *   different schemas; that is refused rather than reapplied.
 * - **A missing file is an error, not a skip.** If a recorded migration is no longer
 *   on disk, the runner cannot tell whether this database is ahead or behind.
 * - **A file that does nothing is an error.** Measured: Postgres accepts an empty or
 *   comment-only query and reports success, so a truncated or badly merged migration
 *   would be recorded as applied — and its checksum would then refuse the real
 *   content forever, because editing an applied migration is the rule above.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Pool } from "pg";
import { withTransaction } from "./pool.js";

/** `001_sites.sql` — three digits, then a snake_case name. */
const FILENAME = /^(\d{3})_[a-z0-9_]+\.sql$/;

/**
 * What must be a migration if it is present at all. Filtering to `.sql` and ignoring
 * everything else would silently skip `005_add_depth.SQL`, `005_add_depth.sql.bak` or
 * `005_add_depth.psql` — a migration that never runs, on a database that then reports
 * itself up to date. Files that look nothing like a migration (`.DS_Store`, a README)
 * are still ignored.
 */
const CANDIDATE = /^\d{3}|\.sql$/i;

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export interface MigrateOptions {
  /** Defaults to this package's `migrations/`; overridden by tests. */
  readonly dir?: string;
}

/**
 * Apply every migration not yet recorded, in numeric order. Returns the filenames it
 * applied — empty on an already-current database, which is what makes the second run
 * of the same set observably a no-op rather than merely quiet.
 */
export async function runMigrations(
  pool: Pool,
  options: MigrateOptions = {},
): Promise<string[]> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const files = await readMigrations(dir);

  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows: recorded } = await pool.query<{ filename: string; checksum: string }>(
    `SELECT filename, checksum FROM schema_migrations`,
  );
  const appliedChecksums = new Map(recorded.map((r) => [r.filename, r.checksum]));

  const onDisk = new Set(files.map((f) => f.filename));
  const vanished = [...appliedChecksums.keys()].filter((f) => !onDisk.has(f));
  if (vanished.length > 0) {
    throw new Error(
      `migrations recorded as applied but missing from ${dir}: ${vanished.join(", ")}. ` +
        `Migrations are forward-only; a deleted one leaves this database unidentifiable.`,
    );
  }

  const applied: string[] = [];
  for (const file of files) {
    const previous = appliedChecksums.get(file.filename);
    if (previous !== undefined) {
      if (previous !== file.checksum) {
        throw new Error(
          `${file.filename} was already applied with checksum ${previous} but now ` +
            `hashes to ${file.checksum}. Migrations are forward-only: add a new file ` +
            `rather than editing an applied one.`,
        );
      }
      continue;
    }
    await withTransaction(pool, async (tx) => {
      await tx.query(file.sql);
      await tx.query(
        `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)`,
        [file.filename, file.checksum],
      );
    });
    applied.push(file.filename);
  }
  return applied;
}

interface MigrationFile {
  readonly filename: string;
  readonly checksum: string;
  readonly sql: string;
}

/**
 * Whether a file has anything for Postgres to do. Comments are stripped crudely — a
 * `--` inside a string literal would be over-removed — which is safe in this
 * direction: the only mistake it can make is calling a real migration non-empty.
 */
function hasStatement(sql: string): boolean {
  return (
    sql
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ")
      .trim() !== ""
  );
}

async function readMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((name) => CANDIDATE.test(name)).sort();
  const seenNumbers = new Map<string, string>();
  const files: MigrationFile[] = [];
  for (const filename of entries) {
    const match = FILENAME.exec(filename);
    if (match === null || match[1] === undefined) {
      throw new Error(
        `${filename} is not a migration filename (expected 001_snake_case.sql)`,
      );
    }
    const clash = seenNumbers.get(match[1]);
    if (clash !== undefined) {
      // Two branches each adding "005_" is the ordinary way this happens, and the
      // resulting order would differ between a fresh database and an upgraded one.
      throw new Error(`migrations ${clash} and ${filename} share the number ${match[1]}`);
    }
    seenNumbers.set(match[1], filename);
    const sql = await readFile(path.join(dir, filename), "utf8");
    if (!hasStatement(sql)) {
      throw new Error(
        `${filename} contains no SQL statement. Postgres would accept it and the ` +
          `runner would record it as applied, after which its checksum refuses the ` +
          `real content.`,
      );
    }
    files.push({
      filename,
      checksum: createHash("sha256").update(sql).digest("hex"),
      sql,
    });
  }
  if (files.length === 0) throw new Error(`no migrations found in ${dir}`);
  return files;
}
