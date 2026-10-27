import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { aliases } from "./aliases.mjs";

// SSR only: every page reads live Postgres data (PRD §9).
//
// The UI is the Link Graph PR pack's (`src/link-graph-ui`, `src/components`, vendored with
// as few changes as possible — see docs/04-operations.md §8); `aliases.mjs` maps the
// package names it imports to those folders. Tailwind is the pack's styling toolchain (its
// stylesheet and shadcn components are written for it).
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    resolve: { dedupe: ["react", "react-dom"], alias: aliases },
  },
});
