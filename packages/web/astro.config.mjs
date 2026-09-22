import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";

// SSR only: every page reads live Postgres data, and step 12's tables have no
// static content to prerender (PRD §9).
//
// React is an island, not the page framework: only PRD §9 item 4's distribution
// charts (the TanStack Charts slot) need client-side interaction (hover tooltips).
// Every other page stays plain server-rendered HTML/SVG, as before.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
});
