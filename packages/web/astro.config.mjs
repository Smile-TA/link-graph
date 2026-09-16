import { defineConfig } from "astro/config";
import node from "@astrojs/node";

// SSR only: every page reads live Postgres data, and step 12's tables have no
// static content to prerender (PRD §9).
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
});
