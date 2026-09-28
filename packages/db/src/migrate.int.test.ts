/**
 * The migration runner, against real Postgres.
 *
 * The named test is "run every migration on an empty database twice; the second run
 * is a no-op". A runner that silently did nothing at all would satisfy a lazily
 * written version of that, so the first run is asserted to have applied every file on
 * disk and to have left every table behind, and the second is asserted not to have
 * disturbed what the first recorded or what was inserted in between.
 *
 * Needs Postgres: `docker compose up -d`. Nothing here skips when it is absent — a
 * green suite that could not reach a database is the failure mode the engineering
 * guide opens with.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, runMigrations } from "./migrate.js";
import { createTempDatabase, type TempDatabase } from "./testing/temp-database.js";

/**
 * The tables PRD §7 names, plus the runner's own bookkeeping, `crawl_frontier` — which
 * PRD §7 does not name and PRD §5.0 does: "Frontier + state | Postgres table" (step 6,
 * `009`) — and `finding_reviews`, which PRD §7.1 names (step 7.6, `011`).
 */
const EXPECTED_TABLES = [
  "crawl_diffs",
  "crawl_frontier",
  "crawl_metrics",
  "crawls",
  "external_urls",
  "finding_reviews",
  "links",
  "pages",
  "registry_health",
  "schema_migrations",
  "sites",
];

const filesOnDisk = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

async function tables(db: TempDatabase): Promise<string[]> {
  const { rows } = await db.pool.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = 'public'`,
  );
  return rows.map((r) => r.name).sort();
}

/** A throwaway migrations directory, for the failure cases. */
async function migrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "link-graph-migrations-"));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(dir, name), sql, "utf8");
  }
  return dir;
}

describe("runMigrations: the real migration set", () => {
  let db: TempDatabase;
  beforeAll(async () => {
    db = await createTempDatabase("migrate");
  });
  afterAll(async () => {
    await db.drop();
  });

  it("applies every migration file, in numeric order", async () => {
    const applied = await runMigrations(db.pool);
    // 002 declares foreign keys into 001, so a wrong order would fail outright.
    expect(applied).toEqual(filesOnDisk());
    expect(applied[0]).toBe("001_sites.sql");
    expect(applied.length).toBeGreaterThanOrEqual(4);
  });

  it("leaves every table PRD §7 names behind", async () => {
    expect(await tables(db)).toEqual(EXPECTED_TABLES);
  });

  it("records one row per file", async () => {
    const { rows } = await db.pool.query<{ filename: string }>(
      `SELECT filename FROM schema_migrations ORDER BY filename`,
    );
    expect(rows.map((r) => r.filename)).toEqual(filesOnDisk());
  });

  it("is a no-op on the second run, and does not disturb the first", async () => {
    // Data written between the two runs must survive: a runner that dropped and
    // recreated the schema would also report "nothing to do" afterwards.
    await db.pool.query(
      `INSERT INTO sites (site_id, canonical_host, aliases, truth_source)
       VALUES ('lionstreet-com', 'lionstreet.com',
               '{lionstreet.com,www.lionstreet.com}', 'sitemap')`,
    );
    const before = await db.pool.query<{ filename: string; applied_at: Date }>(
      `SELECT filename, applied_at FROM schema_migrations ORDER BY filename`,
    );

    const second = await runMigrations(db.pool);

    expect(second).toEqual([]);
    const after = await db.pool.query<{ filename: string; applied_at: Date }>(
      `SELECT filename, applied_at FROM schema_migrations ORDER BY filename`,
    );
    expect(after.rows).toEqual(before.rows);
    expect(await tables(db)).toEqual(EXPECTED_TABLES);
    const { rows: sites } = await db.pool.query<{ site_id: string }>(
      `SELECT site_id FROM sites`,
    );
    expect(sites.map((s) => s.site_id)).toEqual(["lionstreet-com"]);
  });
});

/**
 * `007_drop_soft_orphan.sql` calls itself lossless rather than destructive, and that
 * claim is only exercised by a database that has a `soft_orphan` row in it — which a
 * fresh migration run never does. So this one is built in two halves: the schema as it
 * stood at 006, a row written under the old vocabulary, and then the migration.
 *
 * The reclassification is not a guess. A page classified `soft_orphan` had inbound
 * edges by definition, and the rule that replaced it is "any inbound edge means
 * linked", so `linked` is the answer the new rule gives that row — not the nearest
 * available value.
 */
describe("007 reclassifies the rows it invalidates", () => {
  let db: TempDatabase;
  beforeAll(async () => {
    db = await createTempDatabase("migrate_007");
  });
  afterAll(async () => {
    await db.drop();
  });

  /** The real migration files up to and including `upTo`, byte for byte. */
  async function migrationsUpTo(upTo: string): Promise<string> {
    const files = filesOnDisk().filter((f) => f <= upTo);
    const copies: Record<string, string> = {};
    for (const name of files) {
      copies[name] = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
    }
    return migrationsDir(copies);
  }

  it("turns a soft orphan into a linked page and refuses the value afterwards", async () => {
    // Identical bytes, so the checksums recorded here are the ones the real directory
    // carries — the second run applies 007 and 008 and re-applies nothing.
    await runMigrations(db.pool, { dir: await migrationsUpTo("006_truth_source.sql") });
    const { rows: sites } = await db.pool.query<{ id: number }>(
      `INSERT INTO sites (site_id, canonical_host, aliases, truth_source)
       VALUES ('403bplan-net', '403bplan.net', '{403bplan.net}', 'sitemap')
       RETURNING id`,
    );
    const { rows: crawls } = await db.pool.query<{ id: number }>(
      `INSERT INTO crawls (site_id, started_at, status)
       VALUES ($1, '2026-08-20T09:07:45Z', 'complete') RETURNING id`,
      [sites[0]!.id],
    );
    const crawlId = crawls[0]!.id;
    // The real shape: /contact-us/ was the measured false positive of the dropped rule,
    // and /newsletters/ is a true orphan, which must come through untouched.
    await db.pool.query(
      `INSERT INTO pages (crawl_id, url_normalized, path, in_truth_source, indexable,
                          class)
       VALUES ($1, 'https://403bplan.net/contact-us/', '/contact-us/', true, true,
               'soft_orphan'),
              ($1, 'https://403bplan.net/newsletters/', '/newsletters/', true, true,
               'orphan')`,
      [crawlId],
    );

    expect(await runMigrations(db.pool)).toEqual([
      "007_drop_soft_orphan.sql",
      "008_sample_scope.sql",
      "009_frontier.sql",
      "010_non_content_provenance.sql",
      "011_finding_reviews.sql",
      "012_external_url_detail.sql",
      "013_redirect_alias.sql",
    ]);

    const { rows } = await db.pool.query<{ path: string; class: string }>(
      `SELECT path, class FROM pages WHERE crawl_id = $1 ORDER BY path`,
      [crawlId],
    );
    expect(rows).toEqual([
      { path: "/contact-us/", class: "linked" },
      { path: "/newsletters/", class: "orphan" },
    ]);

    // And the value is gone for good, so nothing can write one back.
    await expect(
      db.pool.query(`UPDATE pages SET class = 'soft_orphan' WHERE crawl_id = $1`, [
        crawlId,
      ]),
    ).rejects.toThrow(/pages_class_known/);
  });
});

describe("runMigrations: refusals", () => {
  it("refuses a migration that was edited after it was applied", async () => {
    const db = await createTempDatabase("edited");
    try {
      const dir = await migrationsDir({ "001_a.sql": "CREATE TABLE a (i int);" });
      expect(await runMigrations(db.pool, { dir })).toEqual(["001_a.sql"]);
      await writeFile(path.join(dir, "001_a.sql"), "CREATE TABLE a (i bigint);", "utf8");
      await expect(runMigrations(db.pool, { dir })).rejects.toThrow(
        /001_a\.sql was already applied with checksum/,
      );
    } finally {
      await db.drop();
    }
  });

  it("leaves nothing behind when a migration fails partway", async () => {
    const db = await createTempDatabase("partial");
    try {
      const dir = await migrationsDir({
        "001_good.sql": "CREATE TABLE good (i int);",
        "002_bad.sql": "CREATE TABLE half (i int);\nCREATE TABLE half (i int);",
      });
      await expect(runMigrations(db.pool, { dir })).rejects.toThrow(/already exists/);
      // The first file applied and is recorded; the second left no table and no row.
      expect(await tables(db)).toEqual(["good", "schema_migrations"]);
      const { rows } = await db.pool.query<{ filename: string }>(
        `SELECT filename FROM schema_migrations`,
      );
      expect(rows.map((r) => r.filename)).toEqual(["001_good.sql"]);
      // ...and it is still resumable: fixing the file moves forward.
      await writeFile(
        path.join(dir, "002_bad.sql"),
        "CREATE TABLE half (i int);",
        "utf8",
      );
      expect(await runMigrations(db.pool, { dir })).toEqual(["002_bad.sql"]);
    } finally {
      await db.drop();
    }
  });

  it("refuses two migrations sharing a number", async () => {
    const db = await createTempDatabase("clash");
    try {
      const dir = await migrationsDir({
        "001_a.sql": "CREATE TABLE a (i int);",
        "001_b.sql": "CREATE TABLE b (i int);",
      });
      await expect(runMigrations(db.pool, { dir })).rejects.toThrow(
        /share the number 001/,
      );
      expect(await tables(db)).toEqual([]);
    } finally {
      await db.drop();
    }
  });

  it("refuses an unnumbered filename", async () => {
    const db = await createTempDatabase("unnumbered");
    try {
      const dir = await migrationsDir({ "schema.sql": "CREATE TABLE a (i int);" });
      await expect(runMigrations(db.pool, { dir })).rejects.toThrow(
        /not a migration filename/,
      );
    } finally {
      await db.drop();
    }
  });

  it("refuses a migration that does nothing, rather than recording it as applied", async () => {
    const db = await createTempDatabase("noop");
    try {
      const dir = await migrationsDir({
        "001_a.sql": "CREATE TABLE a (i int);",
        // Truncated, or a bad merge that kept only the header comment. Postgres
        // accepts this and reports success.
        "002_empty.sql": "-- add the depth column\n\n/* TODO */\n",
      });
      await expect(runMigrations(db.pool, { dir })).rejects.toThrow(
        /002_empty\.sql contains no SQL statement/,
      );
      // Nothing was applied at all: the refusal happens while reading, before the
      // first file runs, so the database is not left half-migrated.
      expect(await tables(db)).toEqual([]);
    } finally {
      await db.drop();
    }
  });

  it("refuses a file that looks like a migration but is not named like one", async () => {
    const db = await createTempDatabase("misnamed");
    try {
      const dir = await migrationsDir({
        "001_a.sql": "CREATE TABLE a (i int);",
        "002_add_depth.sql.bak": "ALTER TABLE a ADD COLUMN d int;",
      });
      await expect(runMigrations(db.pool, { dir })).rejects.toThrow(
        /002_add_depth\.sql\.bak is not a migration filename/,
      );
    } finally {
      await db.drop();
    }
  });

  it("refuses an empty directory rather than reporting an up-to-date database", async () => {
    const db = await createTempDatabase("empty");
    try {
      const dir = await migrationsDir({});
      await expect(runMigrations(db.pool, { dir })).rejects.toThrow(
        /no migrations found/,
      );
    } finally {
      await db.drop();
    }
  });

  it("refuses to run when an applied migration has vanished from disk", async () => {
    const db = await createTempDatabase("vanished");
    try {
      const first = await migrationsDir({ "001_a.sql": "CREATE TABLE a (i int);" });
      expect(await runMigrations(db.pool, { dir: first })).toEqual(["001_a.sql"]);
      const second = await migrationsDir({ "002_b.sql": "CREATE TABLE b (i int);" });
      await expect(runMigrations(db.pool, { dir: second })).rejects.toThrow(
        /recorded as applied but missing/,
      );
    } finally {
      await db.drop();
    }
  });
});
