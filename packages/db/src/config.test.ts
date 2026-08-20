/**
 * Connection settings, with no database involved. `databaseUrl` takes the environment
 * as an argument precisely so this can be tested without mutating `process.env`
 * (engineering guide §4.2).
 */
import { describe, expect, it } from "vitest";
import { databaseUrl } from "./config.js";

describe("databaseUrl", () => {
  it("uses DATABASE_URL when it is set", () => {
    expect(
      databaseUrl({ DATABASE_URL: "postgres://u:p@db.internal:6432/link_graph" }),
    ).toBe("postgres://u:p@db.internal:6432/link_graph");
  });

  it("accepts the postgresql:// spelling too", () => {
    expect(databaseUrl({ DATABASE_URL: "postgresql://localhost/lg" })).toBe(
      "postgresql://localhost/lg",
    );
  });

  it("falls back to the local compose service when it is unset or blank", () => {
    const local = "postgres://link_graph:link_graph@localhost:5432/link_graph";
    expect(databaseUrl({})).toBe(local);
    expect(databaseUrl({ DATABASE_URL: "  " })).toBe(local);
  });

  it("refuses a DSN with no scheme, which URL parsing alone lets through", () => {
    // Measured: `new URL("localhost:5432/link_graph")` succeeds with protocol
    // "localhost:", and pg then reads host "" and database "432/link_graph".
    expect(() => databaseUrl({ DATABASE_URL: "localhost:5432/link_graph" })).toThrow(
      /must use postgres:\/\/ or postgresql:\/\//,
    );
  });

  it("refuses a scheme for some other database", () => {
    expect(() => databaseUrl({ DATABASE_URL: "mysql://u:p@h/db" })).toThrow(
      /must use postgres:\/\/ or postgresql:\/\//,
    );
  });

  it("refuses a DSN that names no database", () => {
    // pg would silently connect to the database named after the user.
    expect(() =>
      databaseUrl({ DATABASE_URL: "postgres://link_graph:link_graph@localhost:5432" }),
    ).toThrow(/names no database/);
  });

  it("refuses something that is not a URL at all", () => {
    expect(() => databaseUrl({ DATABASE_URL: "link_graph@localhost/db" })).toThrow(
      /is not a URL/,
    );
  });
});
