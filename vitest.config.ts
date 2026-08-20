import { configDefaults, defineConfig } from "vitest/config";

/**
 * The unit tier (engineering guide §4.3): pure core plus injected fakes, needs
 * nothing running, budget < 5s. Integration tests live beside it as `*.int.test.ts`
 * and are excluded here, so `npm test` is green with Docker stopped. The integration
 * tier has its own config file rather than a CLI filter — vitest 2 has no `--include`
 * flag, and a positional filter is a path *substring*, so `endpoint.test.ts` would
 * end up in both tiers.
 */
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.int.test.ts"],
    environment: "node",
  },
});
