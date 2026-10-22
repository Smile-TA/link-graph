import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { aliases } from "./aliases.mjs";

/**
 * The pack's UI tests (its own unit and component tiers, ported with it): React Testing
 * Library over jsdom, against synthetic `.test` fixtures — nothing here touches a database
 * or the network. Separate from the repo's root unit tier, which is node-only.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"], alias: aliases },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/components/**/*.test.tsx"],
    environment: "jsdom",
    setupFiles: ["tests/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
