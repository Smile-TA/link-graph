import { defineConfig } from "vitest/config";

/**
 * The integration tier (engineering guide §4.3): one service against real Postgres,
 * budget < 60s. Needs `docker compose up -d --wait`; nothing here skips when the
 * database is unreachable, so a failure to reach it fails the run.
 */
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.int.test.ts"],
    environment: "node",
  },
});
