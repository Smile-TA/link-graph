/**
 * Connection settings come from the environment, with one variable: `DATABASE_URL`.
 *
 * The fallback is the local `docker-compose.yml` service, so `docker compose up -d
 * --wait` followed by `npm run test:integration` works in a fresh checkout with no
 * `.env`. Compose hardcodes the same credentials for the same reason: an override
 * there that this fallback could not see would point the integration suite at a
 * different server while it stayed green.
 */
const LOCAL_COMPOSE_URL = "postgres://link_graph:link_graph@localhost:5432/link_graph";

/** The two schemes libpq accepts. */
const POSTGRES_SCHEMES = ["postgres:", "postgresql:"];

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DATABASE_URL?.trim();
  if (configured === undefined || configured === "") return LOCAL_COMPOSE_URL;

  // Measured 2026-08-20: `new URL` alone is not enough. `localhost:5432/link_graph`
  // parses — scheme `localhost:` — and pg's connection-string parser then reads it as
  // host "" (so, the default host) and database "432/link_graph". A missing scheme is
  // the ordinary typo, and without these two checks it connects somewhere else and
  // fails with "database does not exist" a long way from the cause.
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(
      `DATABASE_URL is not a URL: ${configured} (expected e.g. ${LOCAL_COMPOSE_URL})`,
    );
  }
  if (!POSTGRES_SCHEMES.includes(parsed.protocol)) {
    throw new Error(
      `DATABASE_URL must use postgres:// or postgresql://, got ${parsed.protocol}// ` +
        `in ${configured}`,
    );
  }
  // pg treats a missing path as "the database named after the user", which is never
  // what someone who wrote a DSN meant.
  if (parsed.pathname === "" || parsed.pathname === "/") {
    throw new Error(`DATABASE_URL names no database: ${configured}`);
  }
  return configured;
}
